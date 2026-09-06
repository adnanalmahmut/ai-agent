import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE_NAMES, type QueueJobHandler } from '../../infrastructure/queue';
import { PrismaService } from '../../infrastructure/database';
import type { ToolExecutionStatus } from '../../generated/prisma/client';
import { AgentDefinitionRegistry } from '../../ai/agents/agent-definition.registry';
import type { AgentDefinition } from '../../ai/agents/agent.types';
import { digestValue } from '../../ai/tools/digest';
import {
  TERMINAL_TOOL_EXECUTION_STATUSES,
  ToolExecutionService,
  type EffectSettlement,
  type SideEffectExecutionRow,
} from '../../ai/tools/tool-execution.service';
import { TOOL_IMPLEMENTATIONS } from '../../ai/tools/tool.gateway';
import { ToolRegistry } from '../../ai/tools/tool.registry';
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
} from '../../ai/tools/tool.types';

export type SideEffectExecutionJob = {
  toolExecutionId: string;
  organizationId: string;
};

export const SIDE_EFFECT_ATTEMPT_FAILED = 'Side-effect delivery attempt failed';

export const EFFECT_RETRY_WINDOW_MS = 20 * 60 * 60 * 1_000;

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
        await this.refuse(row, 'provider_rejected', job);
        return;

      case 'unavailable': {
        if (isFinalAttempt(job)) {
          this.log('outcome_unknown', toolExecutionId, job);
          await this.settle(row, { status: 'OUTCOME_UNKNOWN' }, job);
          return;
        }

        this.log('provider_unavailable', toolExecutionId, job);
        throw new Error(SIDE_EFFECT_ATTEMPT_FAILED);
      }
    }
  }

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

      if (!isFinalAttempt(job)) throw new Error(SIDE_EFFECT_ATTEMPT_FAILED);

      return { failureCode: 'implementation_error' };
    }
  }

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

  private async contained<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new Error(SIDE_EFFECT_ATTEMPT_FAILED);
    }
  }

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

function isFinalAttempt(job: Job<SideEffectExecutionJob>): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

export function idempotencyKeyFor(
  row: Pick<SideEffectExecutionRow, 'id' | 'toolId' | 'toolVersion'>,
): string {
  return `${row.toolId}@${row.toolVersion}:${row.id}`;
}
