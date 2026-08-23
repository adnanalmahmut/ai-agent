import { Injectable } from '@nestjs/common';

import { RuntimeConfigResolver } from '../../control-plane';
import { AppException } from '../../core/errors';
import { EMBEDDING_DIMENSIONS, type EmbeddingVector } from '../knowledge.types';
import type { EmbeddingPort } from '../ports/embedding.port';

/**
 * OpenAI embeddings, behind the port.
 *
 * The model is a code constant, not a runtime setting, and that is deliberate.
 * Retrieval only ranks within one model, so changing it invalidates every
 * stored vector until each document has been re-ingested — an operation with
 * no operator surface. A setting that could be flipped in one click and then
 * required a manual sweep to finish would be a footgun; a constant makes the
 * change a deployment, which is what it actually is.
 *
 * `fetch` rather than the `openai` SDK. Two calls' worth of surface does not
 * justify a dependency, and the one thing that matters here — that a provider
 * error never carries the credential — is easier to guarantee when the error
 * is constructed by this file.
 */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

const ENDPOINT = 'https://api.openai.com/v1/embeddings';

/** Kept well under the provider's request ceiling, and under its rate limits. */
const MAX_BATCH = 96;

/** Generous for a large batch, far short of undici's five-minute default. */
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

    /**
     * Resolved per call, not held. A rotated credential has to take effect on
     * the next request rather than on the next deployment, and a long-lived
     * worker would otherwise keep using the key an operator has just retired.
     */
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
        /**
         * Bounded, because the default is undici's ~300s header timeout. A
         * provider that accepts the connection and then stalls would otherwise
         * hold one of a handful of worker slots for five minutes per attempt,
         * three attempts deep, while the queue behind it waits.
         */
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      /**
       * The cause is deliberately dropped. A `fetch` rejection carries the
       * request it failed on, and that request carries the Authorization
       * header — so attaching it would put the credential into whatever logs
       * the exception.
       */
      throw new AppException('AI_PROVIDER_UNAVAILABLE', {
        context: { provider: 'openai', operation: 'embeddings' },
      });
    }

    if (!response.ok) {
      // Released rather than left for the collector: an unread body holds the
      // connection open until it is GC'd.
      void response.body?.cancel();

      /**
       * The status, and nothing from the body. A provider error body is
       * attacker-influenced in the sense that matters here: it is text this
       * application did not write, on its way to a log, and it has been known
       * to echo request content back.
       */
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

    /**
     * Sorted by the provider's own index rather than trusted in order.
     *
     * `embed(texts)[i]` is the vector for `texts[i]` — the port says so, and
     * every caller pairs the results back to chunks positionally. If the
     * provider ever answered out of order, every chunk would be embedded with
     * its neighbour's meaning and nothing would error.
     */
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
