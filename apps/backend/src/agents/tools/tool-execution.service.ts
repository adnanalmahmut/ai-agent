import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database';
import { Prisma } from '../../generated/prisma/client';
import type { AgentValue } from '../agent.types';
import { digestValue } from './digest';
import type { ToolFailureCode } from './tool.types';

/**
 * Statuses from which nothing further can happen to an execution.
 *
 * `REJECTED` and `OUTCOME_UNKNOWN` are terminal alongside the two the
 * read-only lifecycle already had. `AWAITING_APPROVAL` and `APPROVED` are the
 * two states a side effect passes through on its way to one of these.
 */
export const TERMINAL_TOOL_EXECUTION_STATUSES = new Set<string>([
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
  'OUTCOME_UNKNOWN',
]);

/** The execution as the side-effect worker needs to see it, and no more. */
export type SideEffectExecutionRow = {
  id: string;
  organizationId: string;
  agentRunId: string;
  agentRunAttempt: number;
  toolId: string;
  toolVersion: number;
  status: string;
  input: AgentValue;
  effectAttemptCount: number;
  effectFirstAttemptedAt: Date | null;
  effectPayloadDigest: string | null;
  approval: { status: string; inputDigest: string } | null;
  agentRun: {
    agentId: string;
    agentVersion: number;
    organizationAgentVersionId: string | null;
  };
};

/** How an effect attempt ended, as the only three things the worker may write. */
export type EffectSettlement =
  | { status: 'SUCCEEDED'; providerMessageId: string }
  | { status: 'FAILED'; failureCode: ToolFailureCode }
  | { status: 'OUTCOME_UNKNOWN' };

/**
 * The durable half of tool execution.
 *
 * Three narrow writes rather than a repository: a tool execution has exactly
 * one lifecycle and it is linear, so anything more general would be a shape
 * invented for callers that do not exist.
 *
 * The lifecycle is `STARTED -> SUCCEEDED | FAILED`, and it is enforced here
 * rather than merely described. See `transition`.
 *
 * There is deliberately no reconciler. A read-only execution left `STARTED` by
 * a process death is an honest "outcome unknown" for an operation that changed
 * nothing outside this system, and inventing a sweep to force such rows
 * terminal would be guessing at history.
 *
 * A side effect has a second lifecycle, kept on the same row so history is one
 * table: `AWAITING_APPROVAL -> REJECTED | APPROVED -> SUCCEEDED | FAILED |
 * OUTCOME_UNKNOWN`. Its writes are below the read-only ones and follow the same
 * rule — every transition names the state it leaves and requires exactly one
 * row to have left it.
 */
@Injectable()
export class ToolExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records the attempt before the implementation runs.
   *
   * Written after authority, grant, and input validation and before the call,
   * so a row existing means "this was permitted and was handed over" and never
   * "this was asked for". A refused call leaves no row at all, which is what
   * keeps a denial from looking like a failed execution.
   */
  async start(input: {
    organizationId: string;
    agentRunId: string;
    agentRunAttempt: number;
    toolId: string;
    toolVersion: number;
    /** As the application parsed it, never as the caller sent it. */
    input: AgentValue;
  }): Promise<string> {
    const row = await this.prisma.toolExecution.create({
      data: {
        organizationId: input.organizationId,
        agentRunId: input.agentRunId,
        agentRunAttempt: input.agentRunAttempt,
        toolId: input.toolId,
        toolVersion: input.toolVersion,
        status: 'STARTED',
        input: asJson(input.input),
      },
      select: { id: true },
    });

    return row.id;
  }

  /**
   * The result, already parsed by the tool's own output schema.
   *
   * Scoped by `(id, organizationId)` rather than by id alone. The id is a uuid
   * this service just minted and never hands out, so the predicate cannot
   * matter today — but the schema's whole argument for the composite foreign
   * key is that a service predicate is one forgotten `where` clause away from
   * absent, and an update carrying no tenant is that clause missing.
   */
  async succeed(
    id: string,
    organizationId: string,
    output: AgentValue,
  ): Promise<void> {
    await this.transition(id, organizationId, 'SUCCEEDED', {
      output: asJson(output),
    });
  }

  /**
   * A closed application-owned code and nothing else.
   *
   * The parameter type is the union, not `string`, so a future caller cannot
   * reach for `error.message` here without first widening a type that exists
   * to be hard to widen.
   */
  async fail(
    id: string,
    organizationId: string,
    failureCode: ToolFailureCode,
  ): Promise<void> {
    await this.transition(id, organizationId, 'FAILED', { failureCode });
  }

  /**
   * The only way a row leaves `STARTED`, as one compare-and-set.
   *
   * `status: 'STARTED'` is in the `where`, not assumed from the caller having
   * just written it. Without it the two terminal writes are unconditional
   * updates to a row addressed by primary key, which is not a state machine:
   * `FAILED -> SUCCEEDED` and `SUCCEEDED -> FAILED` both succeed, and history
   * ends up recording whichever caller wrote last rather than what happened
   * first. The predicate makes the transition the thing that is atomic, so a
   * second terminal write for the same execution matches nothing and is
   * refused instead of overwriting a settled outcome.
   *
   * `count !== 1` is a throw rather than a return value, and that is the half
   * that matters most. `updateMany` resolves normally when it matches nothing,
   * so a `succeed` whose row was absent, already terminal, or in another
   * tenant used to be indistinguishable from one that committed — and
   * `ToolGateway` would hand the model an output no durable row claimed. There
   * is no durable evidence to return in that case, so the call fails closed
   * and the gateway's containment turns it into a tool failure.
   *
   * `> 1` is unreachable — `id` is the primary key — and is still covered by
   * the same equality rather than by `count === 0`, because the assertion
   * being made is "exactly one row transitioned".
   *
   * Deliberately not a transaction and deliberately not a retry. One statement
   * with a discriminating predicate is already atomic in PostgreSQL, and a
   * losing transition is a fact to report, not a race to re-enter.
   */
  private async transition(
    id: string,
    organizationId: string,
    status: 'SUCCEEDED' | 'FAILED',
    data: Omit<Prisma.ToolExecutionUpdateManyMutationInput, 'status'>,
  ): Promise<void> {
    const { count } = await this.prisma.toolExecution.updateMany({
      where: { id, organizationId, status: 'STARTED' },
      data: { ...data, status, completedAt: new Date() },
    });

    if (count !== 1) {
      /**
       * Carries the execution id and the attempted status and nothing else.
       *
       * No tenant, no input, no output, no row contents: `ToolGateway` catches
       * this and replaces it with its own constant before anything reaches a
       * provider, but it is also the value a future caller might log, and the
       * id is enough to find the row that refused.
       */
      throw new ToolExecutionTransitionError(
        `ToolExecution "${id}" could not transition to ${status}`,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Side effects                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Records a side-effect proposal and the pending decision on it, together.
   *
   * One transaction, because an execution awaiting approval with no approval
   * row to decide it would be stranded forever, and an approval row pointing
   * at no execution would be a decision about nothing. Nothing external
   * happens here — that is the entire point of the state being written.
   *
   * The approval row carries the digest of the parsed input as it stands at
   * this moment. The worker recomputes it before the effect, so the payload an
   * approver saw is provably the payload that is sent.
   */
  async propose(input: {
    organizationId: string;
    agentRunId: string;
    agentRunAttempt: number;
    toolId: string;
    toolVersion: number;
    /** As the application parsed it, never as the model sent it. */
    input: AgentValue;
  }): Promise<string> {
    const inputDigest = digestValue(input.input);

    return this.prisma.$transaction(async (tx) => {
      const execution = await tx.toolExecution.create({
        data: {
          organizationId: input.organizationId,
          agentRunId: input.agentRunId,
          agentRunAttempt: input.agentRunAttempt,
          toolId: input.toolId,
          toolVersion: input.toolVersion,
          status: 'AWAITING_APPROVAL',
          input: asJson(input.input),
        },
        select: { id: true },
      });

      await tx.toolExecutionApproval.create({
        data: {
          organizationId: input.organizationId,
          toolExecutionId: execution.id,
          status: 'PENDING',
          inputDigest,
        },
      });

      return execution.id;
    });
  }

  /**
   * One side-effect execution with its decision and the run's pins.
   *
   * Scoped by the tenant carried in the job payload as well as by id. The
   * payload was written by this application in the approval transaction, but
   * a payload is a payload: one that named another organization must find
   * nothing.
   */
  async loadSideEffect(
    id: string,
    organizationId: string,
  ): Promise<SideEffectExecutionRow | null> {
    const row = await this.prisma.toolExecution.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        organizationId: true,
        agentRunId: true,
        agentRunAttempt: true,
        toolId: true,
        toolVersion: true,
        status: true,
        input: true,
        effectAttemptCount: true,
        effectFirstAttemptedAt: true,
        effectPayloadDigest: true,
        approval: { select: { status: true, inputDigest: true } },
        agentRun: {
          select: {
            agentId: true,
            agentVersion: true,
            organizationAgentVersionId: true,
          },
        },
      },
    });

    if (!row) return null;

    return { ...row, input: row.input as AgentValue };
  }

  /**
   * Claims one delivery attempt, fenced on the count the caller read.
   *
   * `effectAttemptCount = expected` in the predicate is what makes two
   * concurrent deliveries of one approved action unable to both proceed: the
   * first to commit bumps the count, and the second's predicate no longer
   * matches. The loser is told `false` and must reject its job so the queue
   * retries it later — by which time the row is terminal, or reclaimable at
   * the new count if the winner died mid-call.
   *
   * The first attempt also records when it began and the digest of what it is
   * about to send. Both are written once and never overwritten: the window and
   * the payload-stability check on later attempts compare against the first,
   * because the first is the one that may have reached the provider.
   */
  async claimEffectAttempt(
    id: string,
    organizationId: string,
    expectedAttempts: number,
    payloadDigest: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.toolExecution.updateMany({
      where: {
        id,
        organizationId,
        status: 'APPROVED',
        effectAttemptCount: expectedAttempts,
      },
      data: {
        effectAttemptCount: expectedAttempts + 1,
        ...(expectedAttempts === 0
          ? {
              effectFirstAttemptedAt: new Date(),
              effectPayloadDigest: payloadDigest,
            }
          : {}),
      },
    });

    return count === 1;
  }

  /**
   * Settles an approved effect, once.
   *
   * `status: 'APPROVED'` in the predicate: a settlement is the only way out of
   * `APPROVED`, and only one settlement can match. `false` means another
   * delivery settled first — a normal race under at-least-once delivery, and
   * the caller's correct response is to re-read and stop, not to overwrite.
   *
   * `providerMessageId` is written only on success. `OUTCOME_UNKNOWN` writes no
   * failure code: the status is the whole statement, and a code beside it would
   * suggest a cause this application does not know.
   */
  async settleEffect(
    id: string,
    organizationId: string,
    settlement: EffectSettlement,
  ): Promise<boolean> {
    const data: Prisma.ToolExecutionUpdateManyMutationInput =
      settlement.status === 'SUCCEEDED'
        ? {
            status: 'SUCCEEDED',
            providerMessageId: settlement.providerMessageId,
            output: asJson({ status: 'sent' }),
          }
        : settlement.status === 'FAILED'
          ? { status: 'FAILED', failureCode: settlement.failureCode }
          : { status: 'OUTCOME_UNKNOWN' };

    const { count } = await this.prisma.toolExecution.updateMany({
      where: { id, organizationId, status: 'APPROVED' },
      data: { ...data, completedAt: new Date() },
    });

    return count === 1;
  }
}

/**
 * A terminal write that matched no `STARTED` row.
 *
 * Its own type so a caller can tell "the outcome was not recorded" from a
 * driver fault, without reading a message. Nothing does today — `ToolGateway`
 * contains every non-`ToolExecutionFailure` throw identically — but the
 * distinction is the one thing a reader of this failure needs, and recovering
 * it later from an `Error` would mean string matching.
 */
export class ToolExecutionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionTransitionError';
  }
}

function asJson(value: AgentValue): Prisma.InputJsonValue {
  return (value ?? Prisma.JsonNull) as Prisma.InputJsonValue;
}
