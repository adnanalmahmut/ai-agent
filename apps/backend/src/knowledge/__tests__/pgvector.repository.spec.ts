import { describe, expect, it } from '@jest/globals';

import { PgVectorKnowledgeRepository } from '../adapters/pgvector.repository';
import { EMBEDDING_DIMENSIONS } from '../knowledge.types';
import type { PrismaService } from '../../infrastructure/database';

/**
 * The guards that run before the database does.
 *
 * The isolation property itself is proved against real PostgreSQL in
 * `knowledge-isolation.e2e-spec.ts` — an in-memory double cannot demonstrate
 * that a SQL predicate scopes anything. What is here is the set of refusals
 * that must happen *without* a query, because each one would otherwise reach
 * the database as something that looks like a valid search.
 */

const vector = (fill: number) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);

const MODEL = 'test-embedding-model';

/** A search that is valid except for whatever the caller overrides. */
const query = (overrides: Record<string, unknown> = {}) =>
  ({
    organizationId: 'org_a',
    spaceIds: ['space_1'],
    embedding: vector(0.1),
    embeddingModel: MODEL,
    limit: 5,
    ...overrides,
  }) as Parameters<PgVectorKnowledgeRepository['search']>[0];

/** Fails the test if the repository queries at all. */
const forbiddenPrisma = () =>
  ({
    $queryRaw: () => {
      throw new Error('the repository queried when it should have refused');
    },
  }) as unknown as PrismaService;

describe('PgVectorKnowledgeRepository', () => {
  const repository = () => new PgVectorKnowledgeRepository(forbiddenPrisma());

  /**
   * The most important refusal in the file.
   *
   * `WHERE "organizationId" = ''` matches nothing today, so an empty tenant
   * would look like a working query returning no results — and would start
   * matching everything the day someone rewrote the predicate as a conditional
   * one. It has to be an error before it is a query.
   */
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

  /**
   * An empty policy is not permission to read everything. A caller that
   * resolved zero spaces has been granted nothing, and the honest answer is
   * nothing — not a query with the space predicate quietly dropped.
   */
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

  /**
   * The refusal that stops an unbounded read.
   *
   * `Math.min(NaN, ceiling)` is `NaN`, the driver binds `NaN` and `Infinity`
   * as SQL `NULL`, and `LIMIT NULL` in PostgreSQL means *no limit* — so a
   * non-numeric limit would return every embedded chunk in scope and the
   * operator ceiling would be a suggestion. Checked at the SQL boundary as
   * well as in the service, because the port's contract is this file's to keep
   * rather than the caller's to remember.
   */
  it.each([NaN, Infinity, -Infinity, 2.5])(
    'refuses a limit of %p rather than binding it',
    async (limit) => {
      await expect(repository().search(query({ limit }))).rejects.toThrow(
        /whole number/,
      );
    },
  );

  /**
   * Cosine distance is undefined for a zero-norm operand, and pgvector answers
   * `NaN` rather than raising. PostgreSQL then sorts `NaN` last instead of
   * erroring, so the search succeeds, the order is arbitrary, and every
   * threshold a caller applies is false — "nothing is relevant", silently.
   */
  it('refuses an embedding with no direction', async () => {
    await expect(
      repository().search(query({ embedding: vector(0) })),
    ).rejects.toThrow(/no direction/);
  });

  /**
   * Two models' vectors are not comparable, and 1536 dimensions was chosen so
   * one can replace the other *without* a migration that stops traffic — which
   * means the table holds both during re-embedding. A query that did not say
   * which space it was asking in would rank across both and be confidently
   * wrong with no error.
   */
  it('refuses a search that does not say which model embedded it', async () => {
    await expect(
      repository().search(query({ embeddingModel: '  ' })),
    ).rejects.toThrow(/embedding model/);
  });

  /**
   * pgvector rejects a wrong-width vector with its own message. Checking here
   * means the caller is told it embedded with the wrong model, which is the
   * actual fault, rather than reading a type error from the driver.
   */
  it('refuses an embedding of the wrong width', async () => {
    await expect(
      repository().search(query({ embedding: [0.1, 0.2, 0.3] })),
    ).rejects.toThrow(new RegExp(`${EMBEDDING_DIMENSIONS}-dimension`));
  });

  /**
   * `NaN` and `Infinity` serialize as text pgvector will not parse, and the
   * literal is built by joining — so an unchecked one becomes a syntax error
   * inside a value that is otherwise a bound parameter.
   */
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
