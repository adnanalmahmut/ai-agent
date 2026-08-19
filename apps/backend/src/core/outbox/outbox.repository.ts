import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database';

/** An event about to be written, in the same transaction as its business row. */
export type NewOutboxEvent = {
  type: string;
  payload: object;
  /** Passed to BullMQ as the job id. Usually the business row's own id. */
  dedupeKey?: string;
};

/**
 * The minimum a caller must hand `append` for the write to be transactional.
 *
 * Structural rather than `PrismaService`, so the *transaction* client satisfies
 * it and the plain client does too. That is the point: the whole guarantee rests
 * on this insert sharing a transaction with the business row, and a signature
 * that only accepted `PrismaService` would quietly make the correct call
 * impossible to write.
 */
export type OutboxWriter = Pick<PrismaService, 'outboxEvent'>;

/** An event claimed for publication, and only the fields publication needs. */
export type ClaimedOutboxEvent = {
  id: string;
  type: string;
  payload: unknown;
  dedupeKey: string | null;
  /**
   * How many times this row has been claimed, this claim included.
   *
   * Doubles as the claim's version. See `OutboxClaim`.
   */
  attempts: number;
  /** Which dispatcher holds this claim. The other half of the version. */
  claimedBy: string;
};

/**
 * Proof that the caller is still the owner of a claim.
 *
 * There is no separate version column because there does not need to be one:
 * `attempts` already increments atomically inside the claim statement, so
 * `(claimedBy, attempts)` names exactly one claim of exactly one row, and a
 * reclaim after a lapsed lease necessarily produces a different pair.
 *
 * The race this exists to stop is not hypothetical:
 *
 *   A claims the event            attempts = 1, claimedBy = A
 *   A stalls; its lease expires
 *   B reclaims the same event     attempts = 2, claimedBy = B
 *   B publishes and records DELIVERED
 *   A's publish finally fails
 *   A reschedules by id ----------> the row goes back to PENDING
 *
 * The event is then published a second time for no reason, and — worse — the
 * same shape with `markFailed` downgrades a delivered event to `FAILED`. Both
 * are silent. Conditioning the write on the claim makes A's update affect zero
 * rows instead.
 */
export type OutboxClaim = Pick<
  ClaimedOutboxEvent,
  'id' | 'attempts' | 'claimedBy'
>;

export type ClaimOptions = {
  limit: number;
  leaseMs: number;
  claimedBy: string;
  /**
   * The event types this process knows how to route.
   *
   * Not a filter for tidiness — it is the rolling-deployment safeguard. During a
   * rollout an API on the new version writes event types the old worker beside
   * it has never heard of, and a worker that claimed one could only park it. The
   * work would be destroyed before the new worker ever started. Not claiming it
   * leaves it untouched for a process that understands it.
   */
  types: readonly string[];
};

/**
 * How long a `lastError` may be.
 *
 * Provider and driver errors routinely embed the entire failed request —
 * headers, query strings, occasionally the credential that signed it. This
 * column is read by people during an incident, so it is deliberately too small
 * to become an accidental log of secrets.
 */
const MAX_ERROR_LENGTH = 500;

/**
 * The claim's raw row, with `payload` still text.
 *
 * `RETURNING "payload"::text` and a `JSON.parse` rather than letting the column
 * come back as `jsonb`, because whether a driver adapter hands back a parsed
 * object or the raw string is an adapter detail — and one that would surface as
 * a job whose payload is a JSON string instead of an object, days later, in a
 * consumer. A cast makes the answer the same everywhere.
 */
type ClaimedRow = Omit<ClaimedOutboxEvent, 'payload'> & { payload: string };

/**
 * Reads and writes `outbox_event`.
 *
 * The interesting method is `claim`, and it is raw SQL for a reason Prisma
 * cannot express: `FOR UPDATE SKIP LOCKED`. Without `SKIP LOCKED`, two
 * dispatchers selecting the same candidate rows serialise — the second blocks on
 * the first's locks and the pair achieves the throughput of one. With it, the
 * second simply steps over the locked rows and takes the next ones.
 */
@Injectable()
export class OutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an event, on whatever client the caller passes.
   *
   * The client is a parameter because that is the entire mechanism: called with
   * a `$transaction` client alongside the business row's insert, the two commit
   * or roll back together, and "the request succeeded" and "the work is queued"
   * stop being two writes that can disagree. Called with the plain client it is
   * just an insert, which is correct for a caller that has nothing to be atomic
   * with — and wrong for one that does, which is why the choice is at the call
   * site rather than hidden here.
   */
  async append(client: OutboxWriter, event: NewOutboxEvent): Promise<void> {
    await client.outboxEvent.create({
      data: {
        type: event.type,
        payload: event.payload,
        dedupeKey: event.dedupeKey,
      },
    });
  }

  /**
   * Claims up to `limit` deliverable events of known types, and leases them.
   *
   * One statement, not a transaction block. `UPDATE ... WHERE id IN (SELECT ...
   * FOR UPDATE SKIP LOCKED)` is atomic on its own, so the claim commits with the
   * statement and there is no window in which rows are locked while the
   * dispatcher does something slower. That matters here specifically: the next
   * thing the dispatcher does is talk to Redis, and holding database locks across
   * a network call to another system is how a queue outage becomes a database
   * incident.
   *
   * Two kinds of row are claimable, which is the whole recovery mechanism:
   *
   *   PENDING with `availableAt` reached      — new work, or work backed off
   *                                             after a failed publish.
   *   PROCESSING with `leaseExpiresAt` passed — work whose dispatcher died. It
   *                                             may already have been published,
   *                                             which is precisely why delivery
   *                                             is at-least-once and consumers
   *                                             must tolerate a repeat.
   *
   * The type filter applies to *both*, and the second is the one that is easy to
   * get wrong: an old worker that skipped a new event type when it was `PENDING`
   * but reclaimed it once some other process's lease lapsed would destroy it just
   * the same, only less often and therefore less reproducibly.
   *
   * `attempts` increments on claim rather than on failure, for two reasons. It
   * makes `(claimedBy, attempts)` a claim version that a stale writer cannot
   * forge, and it counts the crashes: a dispatcher that dies mid-publish every
   * time never reaches a failure it could record, so a counter that only advanced
   * on clean failures would show nothing at all.
   */
  async claim(options: ClaimOptions): Promise<ClaimedOutboxEvent[]> {
    /**
     * A worker with no routes claims nothing, and asks nothing. `IN ()` is a
     * syntax error rather than an empty result, so this is a correctness guard
     * and not an optimisation.
     */
    if (options.types.length === 0) return [];

    const types = Prisma.join(options.types.map((type) => Prisma.sql`${type}`));

    const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "outbox_event" AS e
      SET "status" = 'PROCESSING',
          "attempts" = e."attempts" + 1,
          "leaseExpiresAt" = NOW() + INTERVAL '1 millisecond' * ${options.leaseMs},
          "claimedBy" = ${options.claimedBy},
          "updatedAt" = NOW()
      WHERE e."id" IN (
        SELECT c."id"
        FROM "outbox_event" AS c
        WHERE c."type" IN (${types})
          AND (
            (c."status" = 'PENDING' AND c."availableAt" <= NOW())
            OR (c."status" = 'PROCESSING' AND c."leaseExpiresAt" <= NOW())
          )
        ORDER BY c."availableAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${options.limit}
      )
      RETURNING e."id",
                e."type",
                e."payload"::text AS "payload",
                e."dedupeKey",
                e."attempts",
                e."claimedBy"
    `;

    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload) as unknown,
    }));
  }

  /**
   * Records that the events reached the queue.
   *
   * The one mutation that is deliberately *not* conditional on still holding the
   * claim, because a successful publish is not an opinion. The job is in Redis;
   * `DELIVERED` is true whatever has happened to the lease in the meantime, and
   * a conditional write would leave a genuinely delivered row `PROCESSING` — the
   * one outcome here that is actually wrong, since it schedules a re-delivery of
   * work that was already delivered.
   *
   * Delivery truth beats stale ownership. Ownership only arbitrates the outcomes
   * that are *judgements* — retry this later, give up on this — and those are
   * exactly the two that are conditional below.
   */
  async markDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'DELIVERED',
        deliveredAt: new Date(),
        leaseExpiresAt: null,
        claimedBy: null,
        lastError: null,
      },
    });
  }

  /**
   * Returns an event to `PENDING`, claimable again after `delayMs`.
   *
   * Conditional on the claim: `status = 'PROCESSING'` and the exact
   * `(claimedBy, attempts)` pair this caller was given. A stale dispatcher whose
   * lease lapsed affects zero rows and is told so, rather than dragging a
   * delivered event back to `PENDING`.
   *
   * Returns whether the row was actually updated. `false` means "somebody else
   * owns this now", which is a normal outcome and not an error — the caller's
   * only correct response is to stop touching the row.
   *
   * Raw, for the same reason `claim` computes its lease from `NOW()`: every
   * timestamp this table compares has to come from the database clock. Written
   * from a worker's clock instead, a machine running a few seconds behind would
   * produce rows that are already claimable the moment they are written, and one
   * running ahead would hold work back — neither visible as anything but
   * intermittent duplicate or delayed delivery.
   */
  async reschedule(
    claim: OutboxClaim,
    delayMs: number,
    error: string,
  ): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "outbox_event"
      SET "status" = 'PENDING',
          "availableAt" = NOW() + INTERVAL '1 millisecond' * ${delayMs},
          "leaseExpiresAt" = NULL,
          "claimedBy" = NULL,
          "lastError" = ${error.slice(0, MAX_ERROR_LENGTH)},
          "updatedAt" = NOW()
      WHERE "id" = ${claim.id}
        AND "status" = 'PROCESSING'
        AND "claimedBy" = ${claim.claimedBy}
        AND "attempts" = ${claim.attempts}
    `;

    return updated > 0;
  }

  /**
   * Parks an event permanently.
   *
   * Only for failures that retrying cannot fix — a payload that can never be
   * serialised, a local routing error that is deterministic. A transport outage
   * is not one of those and must never arrive here; see `classifyPublishError`.
   *
   * Parked rather than deleted: the row is the only record that the work was
   * accepted and not performed, and somebody has to be able to find it.
   *
   * Conditional on the same claim as `reschedule`, and for the sharper version
   * of the same reason. `DELIVERED -> FAILED` is not a wasted re-delivery, it is
   * a lie in the audit trail — and one written by a process that had already
   * lost the right to speak for this row.
   */
  async markFailed(claim: OutboxClaim, error: string): Promise<boolean> {
    const { count } = await this.prisma.outboxEvent.updateMany({
      where: {
        id: claim.id,
        status: 'PROCESSING',
        claimedBy: claim.claimedBy,
        attempts: claim.attempts,
      },
      data: {
        status: 'FAILED',
        leaseExpiresAt: null,
        claimedBy: null,
        lastError: error.slice(0, MAX_ERROR_LENGTH),
      },
    });

    return count > 0;
  }
}
