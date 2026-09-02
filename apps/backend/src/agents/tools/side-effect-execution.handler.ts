import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE_NAMES, type QueueJobHandler } from '../../infrastructure/queue';
import { PrismaService } from '../../infrastructure/database';
import type { ToolExecutionStatus } from '../../generated/prisma/client';
import { AgentDefinitionRegistry } from '../agent-definition.registry';
import type { AgentDefinition } from '../agent.types';
import { digestValue } from './digest';
import {
  TERMINAL_TOOL_EXECUTION_STATUSES,
  ToolExecutionService,
  type EffectSettlement,
  type SideEffectExecutionRow,
} from './tool-execution.service';
import { TOOL_IMPLEMENTATIONS } from './tool.gateway';
import { ToolRegistry } from './tool.registry';
import {
  isSideEffectImplementation,
  isSideEffectPreconditionError,
  isToolRef,
  type AnyToolImplementation,
  type PreparedEffect,
  type SideEffectToolImplementation,
  type ToolFailureCode,
  type ToolInvocationContext,
  type ToolRef,
} from './tool.types';

export type SideEffectExecutionJob = {
  toolExecutionId: string;
  organizationId: string;
};

/**
 * The only text a failed delivery attempt may carry into BullMQ.
 *
 * Every rejection from this handler is this constant, for the same reason the
 * agent execution handler's is: `failedReason` lands in Redis and in the
 * queue's failure log, and nothing about a provider, a recipient, or a row may
 * follow it there.
 */
export const SIDE_EFFECT_ATTEMPT_FAILED = 'Side-effect delivery attempt failed';

/**
 * How long after the *first* attempt a retry may still go to the provider.
 *
 * Resend keeps an idempotency key for 24 hours. Inside that window the same
 * key with the same payload replays the original response without sending,
 * so a retry is safe whether or not the first attempt was received. Past it,
 * the same request would send again. Twenty hours leaves a margin for clock
 * skew and for the attempt itself; a delivery arriving later than that is
 * recorded as an unknown outcome rather than risked.
 *
 * Code-owned, and tied to the one provider this build performs the effect
 * through. A second provider with a different window makes this a property of
 * the delivery port.
 */
export const EFFECT_RETRY_WINDOW_MS = 20 * 60 * 60 * 1_000;

/**
 * Performs an approved side effect, once, after checking everything again.
 *
 * Runs in the worker only. It is handed nothing but two identifiers, and it
 * re-derives every fact from PostgreSQL: the approval was a decision about the
 * world as it stood, and the world has kept moving since.
 *
 * The sequence, and why each step is where it is:
 *
 *   1. Read the execution. Terminal → nothing to do; not approved → nothing
 *      may be done. Both return normally, because a repeat delivery of a
 *      settled action is the normal consequence of at-least-once transport.
 *   2. Revalidate what the application owns: the organization is operational,
 *      the approval stands and covers exactly this input, the run's pinned
 *      version and definition still grant exactly this tool. Any failure
 *      settles `FAILED` with a closed code and sends nothing.
 *   3. Let the tool revalidate what it owns and prepare the effect — the
 *      recipient still belongs here, is deliverable, and this is the payload.
 *   4. Compare against the first attempt: same payload, inside the window.
 *      Otherwise the first attempt may have reached the provider and this one
 *      cannot safely repeat it — `OUTCOME_UNKNOWN`, honestly.
 *   5. Claim the attempt by compare-and-set on the attempt count, so two
 *      deliveries cannot both hold the same attempt.
 *   6. Call the provider with the stable key. Accepted → `SUCCEEDED`; refused
 *      deterministically → `FAILED`; anything else → retry with the same key,
 *      or on the last attempt `OUTCOME_UNKNOWN`.
 *
 * One rule cuts across steps 2, 3 and 6: once any attempt has reached the
 * provider (`effectAttemptCount > 0`), no refusal may be recorded as `FAILED`.
 * A recipient who left between attempts, an archived organization, a revoked
 * grant, or a provider `409` for a changed payload all mean "this must not be
 * sent again" — they do not mean "this was not sent". Those settle
 * `OUTCOME_UNKNOWN`. `FAILED` is reserved for a refusal before the first
 * provider call, when nothing can have left.
 *
 * The attempt fence prevents two deliveries from claiming the same attempt; it
 * does not make the provider call mutually exclusive. A delivery that stalls
 * past the queue's lock can be joined by a second one at the next count, and
 * both may reach the provider with the same key. The key is what prevents a
 * duplicate email in that case; the worst outcome is `OUTCOME_UNKNOWN` for a
 * message that was in fact accepted, which is honest but not exact.
 *
 * The key is derived, never stored and never generated: the same execution
 * yields the same key on every attempt, which is what makes step 6 safe to
 * repeat.
 *
 * Every database call is contained the way `AgentExecutionHandler` contains
 * its durable writes: a Prisma rejection names the connection target and
 * renders its arguments, and this handler's rejection becomes BullMQ's
 * `failedReason` in Redis. Only the constant may follow it there.
 */
@Injectable()
export class SideEffectExecutionHandler implements QueueJobHandler<SideEffectExecutionJob> {
  readonly queue = QUEUE_NAMES.toolSideEffect;
  readonly jobName = 'deliver';

  private readonly implementations: ReadonlyMap<
    ToolRef,
    SideEffectToolImplementation
  >;

  constructor(
    private readonly prisma: PrismaService,
    private readonly executions: ToolExecutionService,
    private readonly registry: ToolRegistry,
    private readonly definitions: AgentDefinitionRegistry,
    @Inject(TOOL_IMPLEMENTATIONS)
    implementations: readonly AnyToolImplementation[],
    private readonly logger: PinoLogger,
  ) {
    const indexed = new Map<ToolRef, SideEffectToolImplementation>();

    for (const implementation of implementations) {
      if (isSideEffectImplementation(implementation)) {
        indexed.set(implementation.ref, implementation);
      }
    }

    this.implementations = indexed;
    this.logger.setContext(SideEffectExecutionHandler.name);
  }

  async handle(job: Job<SideEffectExecutionJob>): Promise<void> {
    const { toolExecutionId, organizationId } = job.data ?? {};

    if (
      typeof toolExecutionId !== 'string' ||
      toolExecutionId.length === 0 ||
      typeof organizationId !== 'string' ||
      organizationId.length === 0
    ) {
      throw new Error(
        'Side-effect job requires toolExecutionId and organizationId',
      );
    }

    const row = await this.executions.loadSideEffect(
      toolExecutionId,
      organizationId,
    );

    if (!row) {
      // The outbox event was committed in the same transaction as the
      // approved row, so this is a payload naming a tenant the row does not
      // belong to, or a row removed by hand. Neither is work for this process.
      this.log('missing', toolExecutionId, job);
      return;
    }

    if (TERMINAL_TOOL_EXECUTION_STATUSES.has(row.status)) {
      this.log('already_settled', toolExecutionId, job, row.status);
      return;
    }

    if (row.status !== 'APPROVED') {
      // AWAITING_APPROVAL, or STARTED for a row that is not a side effect at
      // all. Nothing here may be performed, and no retry will change that.
      this.log('not_approved', toolExecutionId, job, row.status);
      return;
    }

    const refusal = await this.contained(() => this.revalidate(row));

    if (refusal !== null) {
      await this.refuse(row, refusal, job);
      return;
    }

    const ref = `${row.toolId}@${row.toolVersion}`;
    const implementation = this.implementations.get(ref as ToolRef);
    const definition = this.definitions.resolve(
      row.agentRun.agentId,
      row.agentRun.agentVersion,
    );

    if (!implementation) {
      // Unreachable after `revalidate`, which already required it. Kept so
      // the narrowing below is honest rather than asserted.
      await this.refuse(row, 'precondition_authority', job);
      return;
    }

    const prepared = await this.prepare(implementation, row, definition, job);

    if ('failureCode' in prepared) {
      await this.refuse(row, prepared.failureCode, job);
      return;
    }

    /**
     * A later attempt is only safe if it repeats the first one exactly, and
     * soon enough. A changed payload means the approved recipient's address
     * or the rendered message differ from what may already have been sent;
     * an old first attempt means the provider has forgotten the key. Both are
     * unknown outcomes, and both are settled without calling the provider.
     */
    if (row.effectAttemptCount > 0) {
      const changed = row.effectPayloadDigest !== prepared.payloadDigest;
      const expired =
        row.effectFirstAttemptedAt !== null &&
        Date.now() - row.effectFirstAttemptedAt.getTime() >
          EFFECT_RETRY_WINDOW_MS;

      if (changed || expired) {
        this.log(
          changed ? 'payload_changed' : 'window_expired',
          toolExecutionId,
          job,
        );
        await this.settle(row, { status: 'OUTCOME_UNKNOWN' }, job);
        return;
      }
    }

    const claimed = await this.contained(() =>
      this.executions.claimEffectAttempt(
        row.id,
        row.organizationId,
        row.effectAttemptCount,
        prepared.payloadDigest,
      ),
    );

    if (!claimed) {
      // Another delivery holds this attempt. Reject so the queue retries
      // later, by which time the row is settled or reclaimable.
      this.log('claim_lost', toolExecutionId, job);
      throw new Error(SIDE_EFFECT_ATTEMPT_FAILED);
    }

    let outcome: Awaited<ReturnType<PreparedEffect['deliver']>>;

    try {
      outcome = await prepared.deliver(idempotencyKeyFor(row));
    } catch {
      // The port answers with a classification and does not throw; a throw is
      // a defect in an adapter, and the only safe reading of it is "unknown".
      outcome = { kind: 'unavailable' };
    }

    switch (outcome.kind) {
      case 'accepted':
        await this.settle(
          row,
          { status: 'SUCCEEDED', providerMessageId: outcome.providerMessageId },
          job,
        );
        return;

      case 'rejected':
        /**
         * Deterministic on a first attempt: nothing left, and the same payload
         * would be refused again. On a retry it is a different fact — the
         * provider may be refusing *because* an earlier request with this key
         * was accepted with a payload it considers different — so `refuse`
         * resolves it by attempt count rather than by the provider's word.
         */
        await this.refuse(row, 'provider_rejected', job);
        return;

      case 'unavailable': {
        if (isFinalAttempt(job)) {
          /**
           * The provider may have accepted a request whose answer was lost,
           * and the transport is out of attempts. Not `FAILED`: that would
           * claim nothing was sent, and this process cannot know that.
           */
          this.log('outcome_unknown', toolExecutionId, job);
          await this.settle(row, { status: 'OUTCOME_UNKNOWN' }, job);
          return;
        }

        this.log('provider_unavailable', toolExecutionId, job);
        throw new Error(SIDE_EFFECT_ATTEMPT_FAILED);
      }
    }
  }

  /**
   * The application-owned preconditions, read again from the database.
   *
   * Returns the closed code of the first that fails, or `null`. Order matters
   * only for which code is recorded when several fail at once; every check
   * runs against current rows and none trusts anything the job carried.
   */
  private async revalidate(
    row: SideEffectExecutionRow,
  ): Promise<ToolFailureCode | null> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: row.organizationId },
      select: { archivedAt: true },
    });

    if (!organization || organization.archivedAt !== null) {
      return 'precondition_organization';
    }

    if (
      !row.approval ||
      row.approval.status !== 'APPROVED' ||
      row.approval.inputDigest !== digestValue(row.input)
    ) {
      return 'precondition_approval';
    }

    const ref = `${row.toolId}@${row.toolVersion}`;

    if (
      !isToolRef(ref) ||
      !this.registry.has(ref) ||
      this.registry.resolve(ref).risk !== 'side_effect' ||
      !this.implementations.has(ref)
    ) {
      return 'precondition_authority';
    }

    let definition: AgentDefinition;

    try {
      definition = this.definitions.resolve(
        row.agentRun.agentId,
        row.agentRun.agentVersion,
      );
    } catch {
      return 'precondition_authority';
    }

    if (!(definition.maxToolGrants ?? []).includes(ref)) {
      return 'precondition_authority';
    }

    /**
     * The pinned version, through the same predicates the runner uses. It is
     * immutable by design, so this can only fail if the row was changed by
     * hand or the run's pin was — which is exactly the case worth refusing.
     */
    if (row.agentRun.organizationAgentVersionId === null) {
      return 'precondition_authority';
    }

    const version = await this.prisma.organizationAgentVersion.findFirst({
      where: {
        id: row.agentRun.organizationAgentVersionId,
        organizationId: row.organizationId,
        definitionVersion: row.agentRun.agentVersion,
        installation: {
          organizationId: row.organizationId,
          agentId: row.agentRun.agentId,
        },
      },
      select: { toolGrants: true },
    });

    if (!version || !version.toolGrants.includes(ref)) {
      return 'precondition_authority';
    }

    return null;
  }

  /**
   * The tool's own revalidation, with its refusals mapped and everything else
   * treated as transient.
   */
  private async prepare(
    implementation: SideEffectToolImplementation,
    row: SideEffectExecutionRow,
    definition: AgentDefinition,
    job: Job<SideEffectExecutionJob>,
  ): Promise<PreparedEffect | { failureCode: ToolFailureCode }> {
    const context: ToolInvocationContext = {
      organizationId: row.organizationId,
      agentRunId: row.agentRunId,
      agentRunAttempt: row.agentRunAttempt,
      definition,
    };

    try {
      return await implementation.prepareEffect(row.input, context);
    } catch (error) {
      if (isSideEffectPreconditionError(error)) {
        return { failureCode: error.code };
      }

      /**
       * A database fault while resolving the recipient. Not read. Retried
       * while the queue has attempts left; on the last one the row must not be
       * left `APPROVED` with nothing coming back for it, so it is settled —
       * as unknown if an earlier attempt reached the provider, as the tool
       * having failed if none did.
       */
      if (!isFinalAttempt(job)) throw new Error(SIDE_EFFECT_ATTEMPT_FAILED);

      return { failureCode: 'implementation_error' };
    }
  }

  /**
   * Records that the effect will not be performed, honestly.
   *
   * `FAILED` says nothing left this system. That is only knowable before the
   * first provider call, so a refusal reached after any attempt was claimed
   * settles `OUTCOME_UNKNOWN` instead: the precondition that failed explains
   * why nothing more may be sent, not whether something already was.
   */
  private async refuse(
    row: SideEffectExecutionRow,
    failureCode: ToolFailureCode,
    job: Job<SideEffectExecutionJob>,
  ): Promise<void> {
    if (row.effectAttemptCount > 0) {
      this.log('refused_after_attempt', row.id, job, undefined, failureCode);
      await this.settle(row, { status: 'OUTCOME_UNKNOWN' }, job);
      return;
    }

    await this.settle(row, { status: 'FAILED', failureCode }, job);
  }

  /**
   * Runs a durable read or write with its rejection replaced by the constant.
   *
   * The caught value is never read. A Prisma message names the connection
   * target and, for an argument fault, renders the arguments — ids, statuses
   * and a digest here, but the rule is the rule.
   */
  private async contained<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new Error(SIDE_EFFECT_ATTEMPT_FAILED);
    }
  }

  /**
   * Writes the outcome, or discovers that somebody else already did.
   *
   * A settlement that matches nothing is re-read: if the row is terminal, the
   * other delivery's answer stands and this one has nothing to add. If it is
   * not — which cannot happen through this code, since the only way out of
   * `APPROVED` is a settlement — the job rejects so the queue brings it back.
   */
  private async settle(
    row: SideEffectExecutionRow,
    settlement: EffectSettlement,
    job: Job<SideEffectExecutionJob>,
  ): Promise<void> {
    const settled = await this.executions.settleEffect(
      row.id,
      row.organizationId,
      settlement,
    );

    this.log(
      settled ? 'settled' : 'settlement_lost',
      row.id,
      job,
      settlement.status,
      settlement.status === 'FAILED' ? settlement.failureCode : undefined,
    );

    if (settled) return;

    const current = await this.executions.loadSideEffect(
      row.id,
      row.organizationId,
    );

    if (current && TERMINAL_TOOL_EXECUTION_STATUSES.has(current.status)) return;

    throw new Error(SIDE_EFFECT_ATTEMPT_FAILED);
  }

  /**
   * Application-owned identifiers and closed words only. No recipient, no
   * payload, no provider response, no error object.
   */
  private log(
    reason: SideEffectLogReason,
    toolExecutionId: string,
    job: Job<SideEffectExecutionJob>,
    status?: ToolExecutionStatus,
    failureCode?: ToolFailureCode,
  ): void {
    this.logger.info(
      {
        toolExecutionId,
        attemptsStarted: job.attemptsStarted,
        attemptsMade: job.attemptsMade,
        reason,
        ...(status ? { status } : {}),
        ...(failureCode ? { failureCode } : {}),
      },
      'Side-effect delivery',
    );
  }
}

/**
 * The fixed operator vocabulary for a delivery log line.
 *
 * Every value is a literal chosen at the call site from application-owned
 * facts, the same discipline `AgentExecutionHandler.reasonFor` keeps: nothing
 * about a provider, a row or an error decides the word an operator reads.
 */
type SideEffectLogReason =
  | 'missing'
  | 'already_settled'
  | 'not_approved'
  | 'payload_changed'
  | 'window_expired'
  | 'claim_lost'
  | 'refused_after_attempt'
  | 'outcome_unknown'
  | 'provider_unavailable'
  | 'settled'
  | 'settlement_lost';

/**
 * Whether the queue will try again after this delivery rejects.
 *
 * `attemptsMade + 1 >= attempts`, the same arithmetic `AgentExecutionHandler`
 * uses: `attemptsMade` counts finished attempts, so the one in progress is the
 * last when it brings the count to the configured total.
 */
function isFinalAttempt(job: Job<SideEffectExecutionJob>): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/**
 * The stable identity of one approved effect at the provider.
 *
 * `toolId@toolVersion:executionId`: the exact action version and the durable
 * execution it belongs to, so the same execution always yields the same key
 * and two executions never share one. Fifty-six characters for a uuid, well
 * inside the provider's 256. Derived at the moment of sending and stored
 * nowhere, which is also what keeps it out of every log and every row.
 */
export function idempotencyKeyFor(
  row: Pick<SideEffectExecutionRow, 'id' | 'toolId' | 'toolVersion'>,
): string {
  return `${row.toolId}@${row.toolVersion}:${row.id}`;
}
