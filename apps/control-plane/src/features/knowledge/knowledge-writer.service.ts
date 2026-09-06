import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/database';
import { assertUsableVector } from './adapters/pgvector.repository';
import type { EmbeddingVector } from './knowledge.types';

@Injectable()
export class KnowledgeWriterService {
  constructor(private readonly prisma: PrismaService) {}

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
