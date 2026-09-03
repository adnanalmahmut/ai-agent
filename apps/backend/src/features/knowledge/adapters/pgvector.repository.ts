import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../infrastructure/database';
import {
  EMBEDDING_DIMENSIONS,
  type KnowledgeMatch,
  type RetrievalQuery,
} from '../knowledge.types';
import type { RetrievalPort } from '../ports/retrieval.port';

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

    const embedding = `[${query.embedding.join(',')}]`;

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

function assertScoped(query: RetrievalQuery): void {
  if (query.organizationId.trim() === '') {
    throw new Error('Knowledge retrieval requires an organization');
  }

  if (query.embeddingModel.trim() === '') {
    throw new Error('Knowledge retrieval requires the embedding model');
  }

  if (!Number.isSafeInteger(query.limit)) {
    throw new Error('Knowledge retrieval limit must be a whole number');
  }

  assertUsableVector(query.embedding, 'Knowledge retrieval');
}

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

  if (embedding.every((value) => value === 0)) {
    throw new Error(`${subject} embedding has no direction`);
  }
}
