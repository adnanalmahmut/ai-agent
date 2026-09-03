import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '../../../generated/prisma/client';

import { AppException } from '../../../core/errors';
import { KnowledgeIngestionService } from '../knowledge-ingestion.service';
import { KnowledgeSpaceService } from '../knowledge-space.service';

/**
 * The ingestion branches a round trip cannot reach.
 *
 * Everything about this service that involves the database is asserted in
 * `test/e2e/knowledge-management.e2e-spec.ts` against a real PostgreSQL, which
 * is where it belongs. Three things are not reachable that way: which client
 * the outbox row is written through — both work on the happy path and differ
 * only when the transaction rolls back — what happens when the unique index
 * arbitrates a lost race, and the operator byte ceiling, whose default sits
 * above what the controller's own envelope accepts.
 */

const SPACE = 'space_1';
const ORGANIZATION = 'org_1';

/** A registry member, because the taxonomy is code-owned and closed. */
const SLUG = 'brand.voice' as const;

type Fakes = {
  service: KnowledgeIngestionService;
  outboxWriters: unknown[];
  transactionClients: unknown[];
};

const build = (
  options: {
    maxBytes?: number;
    existing?: { checksum: string } | null;
    transaction?: (work: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  } = {},
): Fakes => {
  const outboxWriters: unknown[] = [];
  const transactionClients: unknown[] = [];

  const saved = {
    id: 'doc_1',
    revision: 1,
    sourceUri: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const txClient = {
    // Ingestion ensures the space row inside its own transaction, so the
    // transaction client has to answer the upsert too.
    knowledgeSpace: { upsert: jest.fn(() => Promise.resolve({ id: SPACE })) },
    knowledgeDocument: { upsert: jest.fn(() => Promise.resolve(saved)) },
    knowledgeChunk: {
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      createMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  };

  const prisma = {
    knowledgeSpace: {
      findUnique: jest.fn(() => Promise.resolve({ id: SPACE })),
      upsert: jest.fn(() => Promise.resolve({ id: SPACE })),
    },
    knowledgeDocument: {
      findFirst: jest.fn(() => Promise.resolve(options.existing ?? null)),
      updateManyAndReturn: jest.fn(() =>
        Promise.resolve([{ sourceUri: null, updatedAt: new Date() }]),
      ),
    },
    knowledgeChunk: { count: jest.fn(() => Promise.resolve(0)) },
    $transaction:
      options.transaction ??
      ((work: (tx: unknown) => Promise<unknown>) => {
        transactionClients.push(txClient);

        return work(txClient);
      }),
  };

  const outbox = {
    append: jest.fn((writer: unknown) => {
      outboxWriters.push(writer);

      return Promise.resolve();
    }),
  };

  const runtimeConfig = {
    assertFeature: jest.fn(() => Promise.resolve(undefined)),
    setting: jest.fn(() => Promise.resolve(options.maxBytes ?? 1_000_000)),
  };

  const embeddings = { model: 'model-a', dimensions: 3, maxBatch: 8 };

  /**
   * The real space service over the same fake client.
   *
   * Substituting a double here would let the ingestion path drift from the
   * ensure-inside-the-transaction contract without any test noticing, which is
   * exactly the seam these cases are about.
   */
  const spaces = new KnowledgeSpaceService(
    prisma as never,
    runtimeConfig as never,
  );

  const service = new KnowledgeIngestionService(
    prisma as never,
    outbox as never,
    runtimeConfig as never,
    spaces,
    embeddings as never,
  );

  return { service, outboxWriters, transactionClients };
};

const ingest = (service: KnowledgeIngestionService, content = 'A sentence.') =>
  service.ingest({
    organizationId: ORGANIZATION,
    slug: SLUG,
    title: 'Policies',
    content,
  });

describe('KnowledgeIngestionService', () => {
  /**
   * The outbox row must be written through the transaction client, not the
   * service's own. Both commit when nothing goes wrong, so the difference only
   * shows up on a rollback — as an event announcing a document that was never
   * stored, published to a worker that will never find it.
   */
  it('writes the outbox event through the same transaction as the document', async () => {
    const { service, outboxWriters, transactionClients } = build();

    await ingest(service);

    expect(outboxWriters).toHaveLength(1);
    expect(transactionClients).toHaveLength(1);
    expect(outboxWriters[0]).toBe(transactionClients[0]);
  });

  /**
   * Whether the upsert compiles to `INSERT ... ON CONFLICT` or to a
   * find-then-create is Prisma's decision. Under the second form, two
   * simultaneous first submissions of one title race on the unique index and
   * the loser raises P2002 — an ordinary conflict that must not surface as a
   * 500, and is already answered as a conflict when a space is created twice.
   */
  it('answers a lost race on the title as a conflict', async () => {
    const { service } = build({
      transaction: () => {
        throw new Prisma.PrismaClientKnownRequestError('Unique violation', {
          code: 'P2002',
          clientVersion: 'test',
        });
      },
    });

    await expect(ingest(service)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('lets an unrelated database failure through unchanged', async () => {
    const failure = new Error('connection reset');
    const { service } = build({
      transaction: () => {
        throw failure;
      },
    });

    await expect(ingest(service)).rejects.toBe(failure);
  });

  /**
   * The operator's ceiling, which no request can demonstrate at its default:
   * the controller envelope refuses a larger body first.
   */
  it('refuses a document over the operator byte ceiling', async () => {
    const { service } = build({ maxBytes: 1_024 });

    await expect(ingest(service, 'x'.repeat(2_048))).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('accepts a document exactly at the ceiling', async () => {
    const { service } = build({ maxBytes: 1_024 });

    await expect(ingest(service, 'x'.repeat(1_024))).resolves.toMatchObject({
      changed: true,
    });
  });
});
