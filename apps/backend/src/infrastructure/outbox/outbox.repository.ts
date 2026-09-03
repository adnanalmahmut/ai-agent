import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database';

export type NewOutboxEvent = {
  type: string;
  payload: object;
  dedupeKey?: string;
};

export type OutboxWriter = Pick<PrismaService, 'outboxEvent'>;

export type ClaimedOutboxEvent = {
  id: string;
  type: string;
  payload: unknown;
  dedupeKey: string | null;
  attempts: number;
  claimedBy: string;
};

export type OutboxClaim = Pick<
  ClaimedOutboxEvent,
  'id' | 'attempts' | 'claimedBy'
>;

export type ClaimOptions = {
  limit: number;
  leaseMs: number;
  claimedBy: string;
  types: readonly string[];
};

const MAX_ERROR_LENGTH = 500;

type ClaimedRow = Omit<ClaimedOutboxEvent, 'payload'> & { payload: string };

@Injectable()
export class OutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(client: OutboxWriter, event: NewOutboxEvent): Promise<void> {
    await client.outboxEvent.create({
      data: {
        type: event.type,
        payload: event.payload,
        dedupeKey: event.dedupeKey,
      },
    });
  }

  async claim(options: ClaimOptions): Promise<ClaimedOutboxEvent[]> {
    if (options.types.length === 0) return [];

    const types = Prisma.join(options.types.map((type) => Prisma.sql`${type}`));

    const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
      WITH "candidate" AS (
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
      UPDATE "outbox_event" AS e
      SET "status" = 'PROCESSING',
          "attempts" = e."attempts" + 1,
          "leaseExpiresAt" = NOW() + INTERVAL '1 millisecond' * ${options.leaseMs},
          "claimedBy" = ${options.claimedBy},
          "updatedAt" = NOW()
      FROM "candidate"
      WHERE e."id" = "candidate"."id"
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
