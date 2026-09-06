import { Inject, Injectable } from '@nestjs/common';

import { RuntimeConfigResolver } from '../control-plane';
import type { EmbeddingVector, KnowledgeMatch } from './knowledge.types';
import { RETRIEVAL_PORT, type RetrievalPort } from './ports/retrieval.port';

@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    @Inject(RETRIEVAL_PORT) private readonly retrieval: RetrievalPort,
    private readonly runtimeConfig: RuntimeConfigResolver,
  ) {}

  async search(input: {
    organizationId: string;
    spaceIds: readonly string[];
    embedding: EmbeddingVector;
    embeddingModel: string;
    limit?: number;
  }): Promise<KnowledgeMatch[]> {
    if (input.spaceIds.length === 0) return [];

    const ceiling = await this.runtimeConfig.setting(
      'knowledge.retrieval_max_chunks',
    );
    const requested = input.limit ?? ceiling;

    if (!Number.isSafeInteger(requested)) {
      throw new Error('A knowledge retrieval limit must be a whole number');
    }

    return this.retrieval.search({
      organizationId: input.organizationId,
      spaceIds: input.spaceIds,
      embedding: input.embedding,
      embeddingModel: input.embeddingModel,
      limit: Math.max(0, Math.min(requested, ceiling)),
    });
  }
}
