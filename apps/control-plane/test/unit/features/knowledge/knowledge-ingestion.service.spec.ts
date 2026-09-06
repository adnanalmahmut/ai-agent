import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '../../../../src/generated/prisma/client';

import { AppException } from '../../../../src/core/errors';
import { KnowledgeIngestionService } from '../../../../src/features/knowledge/knowledge-ingestion.service';
import { KnowledgeSpaceService } from '../../../../src/features/knowledge/knowledge-space.service';

const SPACE = 'space_1';
const ORGANIZATION = 'org_1';

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
  it('writes the outbox event through the same transaction as the document', async () => {
    const { service, outboxWriters, transactionClients } = build();

    await ingest(service);

    expect(outboxWriters).toHaveLength(1);
    expect(transactionClients).toHaveLength(1);
    expect(outboxWriters[0]).toBe(transactionClients[0]);
  });

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
