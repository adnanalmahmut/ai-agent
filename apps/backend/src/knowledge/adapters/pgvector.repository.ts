import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/database';
import {
  EMBEDDING_DIMENSIONS,
  type KnowledgeMatch,
  type RetrievalQuery,
} from '../knowledge.types';
import type { RetrievalPort } from '../ports/retrieval.port';

/**
 * The only place in this application that writes vector SQL.
 *
 * Prisma has no vector type, so the ranking query cannot be expressed through
 * the query builder and has to be raw. Confining it here is what keeps that
 * from spreading: a feature asks `RetrievalPort` a question, and the fact that
 * the answer involves `<=>` and a `::vector` cast is this file's business.
 *
 * Everything is a bound parameter. `$queryRaw` with a tagged template sends
 * these as placeholders, never as interpolated text — which matters more here
 * than usual, because the one value that must never be attacker-influenced is
 * the tenant predicate.
 */

/** The row shape the ranking query returns. */
type MatchRow = {
  id: string;
  documentId: string;
  spaceId: string;
  content: string;
  score: number;
};

@Injectable()
export class PgVectorKnowledgeRepository implements RetrievalPort {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: RetrievalQuery): Promise<KnowledgeMatch[]> {
    assertScoped(query);

    if (query.spaceIds.length === 0 || query.limit <= 0) return [];

    /**
     * A pgvector literal, built here rather than passed as an array.
     *
     * `node-postgres` sends a JavaScript array as a PostgreSQL array, which
     * `vector` will not accept, so the value crosses as a string and is cast
     * on the far side. It is still a bound parameter; only its text form is
     * this application's doing, and every element was checked to be a finite
     * number above.
     */
    const embedding = `[${query.embedding.join(',')}]`;

    /**
     * `1 - (a <=> b)` because `<=>` is cosine *distance*: 0 is identical and 2
     * is opposite. Callers reason about similarity, and a threshold written
     * against the wrong polarity is a silent no-op.
     *
     * The organization and space predicates are in this query, not applied to
     * its results. Ranking the whole table and filtering afterwards lets
     * another organization's closer material push this one's out of the top
     * `limit` before the filter runs — a leak that would show up as missing
     * results rather than as an error.
     */
    const rows = await this.prisma.$queryRaw<MatchRow[]>`
      SELECT
        c."id",
        c."documentId",
        c."spaceId",
        c."content",
        1 - (c."embedding" <=> ${embedding}::vector) AS "score"
      FROM "knowledge_chunk" c
      WHERE c."organizationId" = ${query.organizationId}
        AND c."spaceId" = ANY(${query.spaceIds as string[]}::text[])
        AND c."embedding" IS NOT NULL
        AND c."embeddingModel" = ${query.embeddingModel}
      ORDER BY c."embedding" <=> ${embedding}::vector
      LIMIT ${query.limit}
    `;

    return rows.map((row) => ({
      chunkId: row.id,
      documentId: row.documentId,
      spaceId: row.spaceId,
      content: row.content,
      score: Number(row.score),
    }));
  }
}

/**
 * Refuses a query that could not be scoped, before it reaches the database.
 *
 * An empty organization id is not a broader search — `WHERE "organizationId" =
 * ''` happens to match nothing today, and would match everything the moment
 * someone rewrote the predicate. The dimension check is here for the same
 * reason: pgvector rejects a wrong-width vector with its own message, and a
 * caller reading "expected 1536 dimensions, not 768" learns that it embedded
 * with the wrong model, which is the actual fault.
 */

function assertScoped(query: RetrievalQuery): void {
  if (query.organizationId.trim() === '') {
    throw new Error('Knowledge retrieval requires an organization');
  }

  if (query.embeddingModel.trim() === '') {
    throw new Error('Knowledge retrieval requires the embedding model');
  }

  /**
   * A non-integer limit is refused rather than clamped, because the driver
   * binds `NaN` and `Infinity` as SQL `NULL` — and `LIMIT NULL` in PostgreSQL
   * means *no limit*. The operator ceiling would be bypassed by the one input
   * shape a caller is most likely to produce by accident, and the result would
   * be every embedded chunk in scope loaded into memory and then into a
   * prompt. A fractional value is refused for a plainer reason: it reaches
   * PostgreSQL as `invalid input syntax for type bigint`.
   */
  if (!Number.isSafeInteger(query.limit)) {
    throw new Error('Knowledge retrieval limit must be a whole number');
  }

  assertUsableVector(query.embedding, 'Knowledge retrieval');
}

/**
 * The checks a vector must pass before pgvector sees it.
 *
 * Shared with the write path, because a bad vector stored is worse than a bad
 * vector queried: it is wrong on every subsequent search rather than once.
 */
export function assertUsableVector(
  embedding: readonly number[],
  subject: string,
): void {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `${subject} expects a ${EMBEDDING_DIMENSIONS}-dimension embedding`,
    );
  }

  if (!embedding.every((value) => Number.isFinite(value))) {
    throw new Error(`${subject} embedding contains a non-finite value`);
  }

  /**
   * Cosine distance is undefined for a zero-norm operand, and pgvector answers
   * `NaN` rather than raising. `1 - NaN` is `NaN`, PostgreSQL sorts `NaN` last
   * instead of erroring, and every comparison a caller makes against it is
   * false — so a relevance threshold silently reports that nothing is
   * relevant. That is the same silent-wrong-answer this file's other guards
   * exist to refuse.
   */
  if (embedding.every((value) => value === 0)) {
    throw new Error(`${subject} embedding has no direction`);
  }
}
