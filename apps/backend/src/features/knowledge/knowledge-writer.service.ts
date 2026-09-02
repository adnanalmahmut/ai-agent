import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/database';
import { assertUsableVector } from './adapters/pgvector.repository';
import type { EmbeddingVector } from './knowledge.types';

/**
 * Writing an embedding onto a chunk.
 *
 * Separate from retrieval because it is the one other operation that cannot go
 * through Prisma: `embedding` is an `Unsupported` column, so the generated
 * delegate has no way to set it. Ingestion — deciding *what* to chunk and
 * when — is not here; this is the primitive that ingestion will use.
 *
 * Scoped by organization on the write as well as the read. A chunk id is a
 * uuid and guessing one is not a realistic attack, but the predicate costs
 * nothing and means a bug that crosses ids cannot cross tenants with it.
 */
@Injectable()
export class KnowledgeWriterService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attaches a vector to a chunk that already exists.
   *
   * Returns whether a row was updated, so a caller can tell "embedded" from
   * "that chunk is not yours, or no longer exists" — which are the same
   * outcome to a fire-and-forget `UPDATE` and very different to an ingestion
   * pipeline retrying a batch.
   */
  async setEmbedding(input: {
    chunkId: string;
    organizationId: string;
    embedding: EmbeddingVector;
    model: string;
  }): Promise<boolean> {
    if (input.organizationId.trim() === '') {
      throw new Error('Embedding a knowledge chunk requires an organization');
    }

    if (input.model.trim() === '') {
      throw new Error('A stored embedding must record the model that made it');
    }

    /**
     * The same guards the read path uses, and for a stronger reason: a bad
     * vector queried is one wrong answer, a bad vector stored is a wrong
     * answer on every search until someone notices. A zero-norm row in
     * particular makes cosine distance `NaN`, which PostgreSQL sorts last
     * rather than rejecting — so the row is silently unrankable forever.
     */
    assertUsableVector(input.embedding, 'A knowledge embedding');

    const literal = `[${input.embedding.join(',')}]`;

    const updated = await this.prisma.$executeRaw`
      UPDATE "knowledge_chunk"
      SET "embedding" = ${literal}::vector,
          "embeddingModel" = ${input.model}
      WHERE "id" = ${input.chunkId}
        AND "organizationId" = ${input.organizationId}
    `;

    return updated > 0;
  }
}
