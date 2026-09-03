import { Injectable } from '@nestjs/common';

import { RuntimeConfigResolver } from '../../control-plane';
import { AppException } from '../../../core/errors';
import {
  APPLICATION_MODEL_CATALOG,
  MODEL_IDS,
} from '../../../ai/models/model-catalog';
import { EMBEDDING_DIMENSIONS, type EmbeddingVector } from '../knowledge.types';
import type { EmbeddingPort } from '../ports/embedding.port';

const catalogModel = APPLICATION_MODEL_CATALOG.embeddingModel(
  MODEL_IDS.openAiTextEmbedding3Small,
);

export const EMBEDDING_MODEL = catalogModel.providerModelId;

if (catalogModel.capabilities.dimensions !== EMBEDDING_DIMENSIONS) {
  throw new Error(
    `Embedding model "${catalogModel.id}" does not match the deployed ${EMBEDDING_DIMENSIONS}-dimension schema`,
  );
}

const ENDPOINT = 'https://api.openai.com/v1/embeddings';

const MAX_BATCH = 96;

const REQUEST_TIMEOUT_MS = 60_000;

type EmbeddingResponse = {
  data?: { index?: number; embedding?: number[] }[];
};

@Injectable()
export class OpenAiEmbeddingAdapter implements EmbeddingPort {
  readonly model = EMBEDDING_MODEL;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly maxBatch = MAX_BATCH;

  constructor(private readonly runtimeConfig: RuntimeConfigResolver) {}

  async embed(texts: readonly string[]): Promise<EmbeddingVector[]> {
    if (texts.length === 0) return [];

    const apiKey = await this.runtimeConfig.secret('openai.api_key');

    const vectors: EmbeddingVector[] = [];

    for (let start = 0; start < texts.length; start += MAX_BATCH) {
      const batch = texts.slice(start, start + MAX_BATCH);
      vectors.push(...(await this.embedBatch(batch, apiKey)));
    }

    return vectors;
  }

  private async embedBatch(
    batch: readonly string[],
    apiKey: string,
  ): Promise<EmbeddingVector[]> {
    let response: Response;

    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: [...batch] }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AppException('AI_PROVIDER_UNAVAILABLE', {
        context: { provider: 'openai', operation: 'embeddings' },
      });
    }

    if (!response.ok) {
      // Released rather than left for the collector: an unread body holds the
      // connection open until it is GC'd.
      void response.body?.cancel();

      throw new AppException('AI_PROVIDER_UNAVAILABLE', {
        context: {
          provider: 'openai',
          operation: 'embeddings',
          status: response.status,
        },
      });
    }

    const body = (await response.json()) as EmbeddingResponse;
    const data = body.data;

    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new AppException('AI_PROVIDER_UNAVAILABLE', {
        context: { provider: 'openai', operation: 'embeddings' },
      });
    }

    const ordered = [...data].sort(
      (left, right) => (left.index ?? 0) - (right.index ?? 0),
    );

    return ordered.map((entry) => {
      const vector = entry.embedding;

      if (!Array.isArray(vector) || vector.length !== this.dimensions) {
        throw new AppException('AI_PROVIDER_UNAVAILABLE', {
          context: {
            provider: 'openai',
            operation: 'embeddings',
            reason: 'unexpected_dimensions',
          },
        });
      }

      return vector;
    });
  }
}
