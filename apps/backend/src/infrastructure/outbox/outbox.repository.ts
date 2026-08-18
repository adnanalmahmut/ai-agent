import { Injectable } from '@nestjs/common';

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
  attempts: number;
};

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
 * How long a `lastError` may be.
 *
 * Provider and driver errors routinely embed the entire failed request —
 * headers, query strings, occasionally the credential that signed it. This
 * column is read by people during an incident, so it is deliberately too small
 * to become an accidental log of secrets.
 */
const MAX_ERROR_LENGTH = 500;

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
   * Claims up to `limit` deliverable events and leases them.
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
   * `attempts` increments on claim rather than on failure. Counting attempted
   * claims is what bounds a poison event: a dispatcher that dies mid-publish
   * every time would never reach a failure it could record, and an attempt
   * counter that only advanced on clean failures would let it be retried
   * forever.
   */
  async claim(
    limit: number,
    leaseMs: number,
    claimedBy: string,
  ): Promise<ClaimedOutboxEvent[]> {
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "outbox_event" AS e
      SET "status" = 'PROCESSING',
          "attempts" = e."attempts" + 1,
          "leaseExpiresAt" = NOW() + INTERVAL '1 millisecond' * ${leaseMs},
          "claimedBy" = ${claimedBy},
          "updatedAt" = NOW()
      WHERE e."id" IN (
        SELECT c."id"
        FROM "outbox_event" AS c
        WHERE (c."status" = 'PENDING' AND c."availableAt" <= NOW())
           OR (c."status" = 'PROCESSING' AND c."leaseExpiresAt" <= NOW())
        ORDER BY c."availableAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING e."id",
                e."type",
                e."payload"::text AS "payload",
                e."dedupeKey",
                e."attempts"
    `;

    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload) as unknown,
    }));
  }

  /**
   * Records that the events reached the queue.
   *
   * Not conditional on still holding the lease. If a lease lapsed and another
   * dispatcher reclaimed the row, `DELIVERED` is still the truth — this process
   * did publish it — and the reclaiming dispatcher publishing a second time is
   * the at-least-once contract working as specified, not a race to be arbitrated
   * here. Making this conditional would leave the row `PROCESSING` after a
   * successful publish, which is the one outcome that is actually wrong.
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
   * The lease is cleared rather than left to expire, so a deliberate retry is
   * distinguishable from a crash: a row waiting on `availableAt` was handed back,
   * a row waiting on `leaseExpiresAt` was dropped.
   *
   * Raw, for the same reason `claim` computes its lease from `NOW()`: every
   * timestamp this table compares has to come from the database clock. Written
   * from a worker's clock instead, a machine running a few seconds behind would
   * produce rows that are already claimable the moment they are written, and one
   * running ahead would hold work back — neither visible as anything but
   * intermittent duplicate or delayed delivery.
   */
  async reschedule(id: string, delayMs: number, error: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "outbox_event"
      SET "status" = 'PENDING',
          "availableAt" = NOW() + INTERVAL '1 millisecond' * ${delayMs},
          "leaseExpiresAt" = NULL,
          "claimedBy" = NULL,
          "lastError" = ${error.slice(0, MAX_ERROR_LENGTH)},
          "updatedAt" = NOW()
      WHERE "id" = ${id}
    `;
  }

  /**
   * Parks an event permanently.
   *
   * For the two cases where retrying cannot help: the attempt budget is spent,
   * or the event's `type` has no route and never will. Parked rather than
   * deleted — the row is the only record that the work was accepted and not
   * performed, and somebody has to be able to find it.
   *
   * `updateMany`, so a row that has since been removed is a no-op rather than a
   * thrown `P2025`. A dispatcher pass must not fail over an event that no longer
   * exists; the rest of its batch still has to be recorded.
   */
  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: { id },
      data: {
        status: 'FAILED',
        leaseExpiresAt: null,
        claimedBy: null,
        lastError: error.slice(0, MAX_ERROR_LENGTH),
      },
    });
  }
}
