import { describe, expect, it } from '@jest/globals';

import { PgVectorKnowledgeRepository } from '../../../../src/features/knowledge/adapters/pgvector.repository';
import { EMBEDDING_DIMENSIONS } from '../../../../src/features/knowledge/knowledge.types';
import type { PrismaService } from '../../../../src/infrastructure/database';

const vector = (fill: number) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);

const MODEL = 'test-embedding-model';

const query = (overrides: Record<string, unknown> = {}) =>
  ({
    organizationId: 'org_a',
    spaceIds: ['space_1'],
    embedding: vector(0.1),
    embeddingModel: MODEL,
    limit: 5,
    ...overrides,
  }) as Parameters<PgVectorKnowledgeRepository['search']>[0];

const forbiddenPrisma = () =>
  ({
    $queryRaw: () => {
      throw new Error('the repository queried when it should have refused');
    },
  }) as unknown as PrismaService;

describe('PgVectorKnowledgeRepository', () => {
  const repository = () => new PgVectorKnowledgeRepository(forbiddenPrisma());

  it('refuses a search with no organization rather than running one', async () => {
    await expect(
      repository().search(
        query({
          organizationId: '',
          spaceIds: ['space_1'],
          embedding: vector(0.1),
          limit: 5,
        }),
      ),
    ).rejects.toThrow(/requires an organization/);
  });

  it('refuses an organization that is only whitespace', async () => {
    await expect(
      repository().search(
        query({
          organizationId: '   ',
          spaceIds: ['space_1'],
          embedding: vector(0.1),
          limit: 5,
        }),
      ),
    ).rejects.toThrow(/requires an organization/);
  });

  it('returns nothing, and asks nothing, when no space was granted', async () => {
    await expect(
      repository().search(
        query({
          organizationId: 'org_a',
          spaceIds: [],
          embedding: vector(0.1),
          limit: 5,
        }),
      ),
    ).resolves.toEqual([]);
  });

  it('returns nothing when no chunks were asked for', async () => {
    await expect(
      repository().search(
        query({
          organizationId: 'org_a',
          spaceIds: ['space_1'],
          embedding: vector(0.1),
          limit: 0,
        }),
      ),
    ).resolves.toEqual([]);
  });

  it.each([NaN, Infinity, -Infinity, 2.5])(
    'refuses a limit of %p rather than binding it',
    async (limit) => {
      await expect(repository().search(query({ limit }))).rejects.toThrow(
        /whole number/,
      );
    },
  );

  it('refuses an embedding with no direction', async () => {
    await expect(
      repository().search(query({ embedding: vector(0) })),
    ).rejects.toThrow(/no direction/);
  });

  it('refuses a search that does not say which model embedded it', async () => {
    await expect(
      repository().search(query({ embeddingModel: '  ' })),
    ).rejects.toThrow(/embedding model/);
  });

  it('refuses an embedding of the wrong width', async () => {
    await expect(
      repository().search(query({ embedding: [0.1, 0.2, 0.3] })),
    ).rejects.toThrow(new RegExp(`${EMBEDDING_DIMENSIONS}-dimension`));
  });

  it.each([NaN, Infinity, -Infinity])(
    'refuses an embedding containing %p',
    async (bad) => {
      const embedding = vector(0.1);
      embedding[7] = bad;

      await expect(repository().search(query({ embedding }))).rejects.toThrow(
        /non-finite/,
      );
    },
  );
});
