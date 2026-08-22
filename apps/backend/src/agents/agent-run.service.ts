import { Injectable } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../database';
import { OutboxRepository } from '../core/outbox';
import type {
  AgentRun,
  AgentRunStatus,
  AgentValue,
  CreateAgentRun,
} from './agent.types';

const AGENT_RUN_QUEUED = 'agent-run.queued';

/**
 * The durable diagnostic written when the transport, not the application, ended
 * a run.
 *
 * An application-owned constant rather than BullMQ's `failedReason`. The string
 * BullMQ would supply ("job stalled more than allowable limit") is authored by
 * the transport and free to change between versions, and a policy of copying
 * transport-authored text into a business column is exactly how provider
 * response bodies eventually end up there too.
 */
export const TERMINAL_TRANSPORT_FAILURE =
  'Agent execution ended without a result';

type PersistedAgentRun = Awaited<
  ReturnType<PrismaService['agentRun']['findUniqueOrThrow']>
>;

/** Internal acceptance boundary for durable background agent work. */
@Injectable()
export class AgentRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
  ) {}

  /**
   * Commits the run and its queue intent together.
   *
   * Authorization is intentionally not performed here: this slice has no HTTP
   * operation. A future real-agent feature must authorize before calling this
   * internal service and must supply a registered definition/runtime pair.
   */
  async create(input: CreateAgentRun): Promise<AgentRun> {
    const existing = await this.findByIdempotencyKey(input);
    if (existing) return toAgentRun(existing);

    try {
      const run = await this.prisma.$transaction(async (tx) => {
        const created = await tx.agentRun.create({
          data: {
            agentId: input.agentId,
            agentVersion: input.agentVersion,
            runtime: input.runtime,
            organizationId: input.organizationId,
            createdByUserId: input.createdByUserId,
            input: input.input as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey,
          },
        });

        await this.outbox.append(tx, {
          type: AGENT_RUN_QUEUED,
          payload: { runId: created.id },
          dedupeKey: created.id,
        });

        return created;
      });

      return toAgentRun(run);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      const winner = await this.findByIdempotencyKey(input);

      // A P2002 on this insert can only be the durable idempotency constraint.
      // Still fail loudly if the winning row cannot be observed instead of
      // manufacturing a success response with no durable authority behind it.
      if (!winner) throw error;

      return toAgentRun(winner);
    }
  }

  /**
   * Atomically claims exactly the BullMQ attempt currently being delivered.
   *
   * The attempt counter stores BullMQ's active-start ordinal as the claim
   * version. A duplicate delivery can observe the same/newer version but cannot
   * claim it or execute the runtime again. Unlike attemptsMade, that ordinal
   * also advances when BullMQ recovers a stalled job after worker death.
   */
  async claimExecutionAttempt(
    runId: string,
    attemptsStarted: number,
  ): Promise<AgentRun | null> {
    if (!Number.isInteger(attemptsStarted) || attemptsStarted < 1) {
      throw new Error(
        'Agent execution attempt number must be a positive integer',
      );
    }

    // A worker may stall before it reaches this transaction. Any active
    // delivery can therefore be the first durable claim, and its BullMQ start
    // ordinal becomes the CAS version without inventing a lease system here.
    const queuedClaim = await this.prisma.agentRun.updateManyAndReturn({
      where: {
        id: runId,
        status: 'QUEUED',
        attemptCount: { lt: attemptsStarted },
      },
      data: {
        status: 'RUNNING',
        attemptCount: attemptsStarted,
        lastError: null,
        startedAt: new Date(),
      },
    });

    if (queuedClaim[0]) return toAgentRun(queuedClaim[0]);

    // Monotonic, not exact-predecessor. BullMQ increments `attemptsStarted`
    // inside Redis at move-to-active, before any of this process runs, so a
    // worker that is killed between activation and this statement consumes an
    // ordinal PostgreSQL never observes. The durable sequence is therefore
    // strictly increasing but may have gaps: after a claim at 1, the next
    // delivery to arrive here can legitimately be 3. Requiring
    // `attemptCount === attemptsStarted - 1` wedges exactly that run.
    //
    // `attemptsStarted` is unique per delivery and never decreases, which is
    // what makes it usable as a fencing token: a greater ordinal is a newer
    // delivery and may take ownership, an equal or lesser one is stale or
    // duplicate and must do nothing.
    const runningClaim = await this.prisma.agentRun.updateManyAndReturn({
      where: {
        id: runId,
        status: 'RUNNING',
        attemptCount: { lt: attemptsStarted },
      },
      data: {
        attemptCount: attemptsStarted,
        lastError: null,
      },
    });

    if (runningClaim[0]) return toAgentRun(runningClaim[0]);

    const current = await this.prisma.agentRun.findUnique({
      where: { id: runId },
    });

    if (!current) throw new Error(`AgentRun "${runId}" does not exist`);

    // Terminal runs are finished business truth; a late delivery cannot
    // reopen them. A stale or duplicate active start for a run already at or
    // beyond this ordinal is a safe no-op: the newer delivery owns the work.
    return null;
  }

  async markExecutionSucceeded(
    runId: string,
    attemptCount: number,
    output: AgentValue,
  ): Promise<boolean> {
    const { count } = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: 'RUNNING', attemptCount },
      data: {
        status: 'SUCCEEDED',
        // `== null` on purpose: Prisma treats an `undefined` field as "do not
        // update", so an SDK returning no output would record SUCCEEDED with a
        // silently missing result instead of an explicit JSON null.
        output:
          output == null ? Prisma.JsonNull : (output as Prisma.InputJsonValue),
        lastError: null,
        completedAt: new Date(),
      },
    });

    return count === 1;
  }

  async recordExecutionFailure(
    runId: string,
    attemptCount: number,
    lastError: string,
    final: boolean,
  ): Promise<boolean> {
    const { count } = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: 'RUNNING', attemptCount },
      data: final
        ? {
            status: 'FAILED',
            lastError,
            completedAt: new Date(),
          }
        : { lastError },
    });

    return count === 1;
  }

  /**
   * A bounded page of runs that are not finished and have gone quiet.
   *
   * Ordered oldest-first so a backlog drains in the order it accumulated, and
   * limited so one pass costs the same whatever the backlog is. `updatedAt`
   * rather than `startedAt`, because a run that never left `QUEUED` has no
   * `startedAt` and is precisely one of the cases that can be stranded.
   *
   * The staleness bound is a cost control and nothing more. Every candidate is
   * still checked against the transport before anything is written, so
   * including a run that turns out to be healthy is wasted work rather than a
   * wrong outcome.
   */
  findStaleNonTerminal(
    staleBefore: Date,
    limit: number,
  ): Promise<{ id: string; status: AgentRunStatus; attemptCount: number }[]> {
    return this.prisma.agentRun.findMany({
      where: {
        status: { in: ['QUEUED', 'RUNNING'] },
        updatedAt: { lt: staleBefore },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true, status: true, attemptCount: true },
    });
  }

  /**
   * Finalizes a run whose transport job has terminally failed.
   *
   * Deliberately not gated on `attemptCount`. The attempt fence exists so one
   * delivery cannot overwrite another delivery's outcome, and this caller is not
   * a delivery — it is the observation that the transport has stopped producing
   * deliveries at all. Gating it on an ordinal would mean guessing which
   * abandoned attempt to impersonate, and the guess would be wrong exactly in
   * the skipped-ordinal case the fence was introduced for.
   *
   * The status filter is what keeps it safe. `SUCCEEDED` and `FAILED` are
   * finished business truth and match nothing, so a duplicate, delayed, or
   * reordered observation is a no-op, and a run that a late worker managed to
   * complete is never dragged back to failed. A run that does not exist matches
   * nothing either, which is the correct answer rather than an error: the
   * transport can outlive the row it referred to.
   */
  async reconcileTerminalFailure(runId: string): Promise<boolean> {
    const { count } = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        lastError: TERMINAL_TRANSPORT_FAILURE,
        completedAt: new Date(),
      },
    });

    return count === 1;
  }

  private findByIdempotencyKey(
    input: Pick<CreateAgentRun, 'organizationId' | 'idempotencyKey'>,
  ) {
    return this.prisma.agentRun.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
  }
}

function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Mapped field by field rather than spread. A spread is not excess-property
 * checked, so every column the Prisma model gains would silently become part
 * of the application-owned contract this module exists to keep separate.
 */
function toAgentRun(run: PersistedAgentRun): AgentRun {
  return {
    id: run.id,
    agentId: run.agentId,
    agentVersion: run.agentVersion,
    runtime: run.runtime,
    status: run.status,
    organizationId: run.organizationId,
    createdByUserId: run.createdByUserId,
    input: run.input as AgentValue,
    output: run.output as AgentValue | null,
    lastError: run.lastError,
    attemptCount: run.attemptCount,
    idempotencyKey: run.idempotencyKey,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
