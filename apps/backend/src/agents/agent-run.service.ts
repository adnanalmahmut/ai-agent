import { Injectable } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../database';
import { AppException } from '../core/errors';
import { OutboxRepository } from '../core/outbox';
import {
  TERMINAL_TRANSPORT_FAILURE,
  type AgentFailureDiagnostic,
  type AgentRun,
  type AgentRunStatus,
  type AgentValue,
  type CreateAgentRun,
} from './agent.types';

const AGENT_RUN_QUEUED = 'agent-run.queued';

type PersistedAgentRun = Awaited<
  ReturnType<PrismaService['agentRun']['findUniqueOrThrow']>
>;

/** Where a reconciliation pass got to, so the next one resumes rather than restarts. */
export type StaleRunCursor = { updatedAt: Date; id: string };

/**
 * Only what a reconciliation decision needs.
 *
 * Deliberately not the whole row: `input` and `output` hold prompts and model
 * results, and `organizationId` and `createdByUserId` identify a tenant. None
 * of it informs the decision, so none of it is loaded into a process whose job
 * is to write log lines about these rows.
 */
export type StaleAgentRun = {
  id: string;
  status: AgentRunStatus;
  attemptCount: number;
  updatedAt: Date;
};

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

    /**
     * Checked here rather than at the controller, because here is the first
     * point that knows this is new work.
     *
     * A caller retrying a request that timed out has already been accepted and
     * has already been paid for; refusing their retry at a ceiling they are
     * themselves part of would strand a run they can no longer reach. The
     * idempotency short-circuit above runs first for exactly that reason.
     *
     * A ceiling, not a semaphore. Two accepts racing can both observe room and
     * both take it, so the bound is exceeded by at most the number of requests
     * in flight at that instant. Making it exact needs a serializable
     * transaction or a lock on the acceptance path, which is a real cost paid
     * on every request to tighten a spend control by one or two runs.
     */
    await this.assertCapacity(input);

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
    lastError: AgentFailureDiagnostic,
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
   * Ordered oldest-first so a backlog is examined in the order it accumulated,
   * and limited so one pass returns a fixed number of rows however large the
   * backlog is. (The number of rows is bounded; the cost of finding them is
   * not strictly — see the index note in `docs/database.md`.) `updatedAt`
   * rather than `startedAt`, because a run that never left `QUEUED` has no
   * `startedAt` and is precisely one of the cases that can be stranded.
   *
   * `after` is a keyset cursor, and it is what makes the sweep make progress
   * rather than merely make queries. A candidate the caller cannot act on is
   * left unwritten, so its `updatedAt` never moves and oldest-first would hand
   * back the same rows forever; once enough of them exist, no newer run is ever
   * examined again and the recovery mechanism silently stops recovering.
   * Paging past what has already been seen bounds each row's influence to one
   * visit per cycle.
   *
   * The staleness bound is a cost control and nothing more. Every candidate is
   * still checked against the transport before anything is written, so
   * including a run that turns out to be healthy is wasted work rather than a
   * wrong outcome.
   */
  findStaleNonTerminal(
    staleBefore: Date,
    limit: number,
    after?: StaleRunCursor,
  ): Promise<StaleAgentRun[]> {
    return this.prisma.agentRun.findMany({
      where: {
        status: { in: ['QUEUED', 'RUNNING'] },
        updatedAt: { lt: staleBefore },
        // `updatedAt` is not unique, so the cursor is the pair. Comparing on
        // the timestamp alone would skip every row sharing the last one's
        // millisecond.
        ...(after
          ? {
              OR: [
                { updatedAt: { gt: after.updatedAt } },
                { updatedAt: after.updatedAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, status: true, attemptCount: true, updatedAt: true },
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

  /**
   * Reads one run, scoped to the organization that owns it.
   *
   * The organization is a predicate rather than a check on the result: a run
   * id from another tenant must be indistinguishable from one that does not
   * exist, and comparing after the read is how that distinction leaks back
   * out through a different error.
   */
  async findForOrganization(input: {
    runId: string;
    organizationId: string;
  }): Promise<AgentRun | null> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: input.runId, organizationId: input.organizationId },
    });

    return run === null ? null : toAgentRun(run);
  }

  private async assertCapacity(input: CreateAgentRun): Promise<void> {
    const { maxInFlight } = input;

    if (maxInFlight === undefined) return;

    const inFlight = await this.prisma.agentRun.count({
      where: {
        organizationId: input.organizationId,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
    });

    if (inFlight < maxInFlight) return;

    throw new AppException('TOO_MANY_REQUESTS', {
      context: { resource: 'agentRun', organizationId: input.organizationId },
      publicDetails: {
        reason:
          'This organization already has the maximum number of agent runs in flight. Wait for one to finish.',
      },
    });
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
