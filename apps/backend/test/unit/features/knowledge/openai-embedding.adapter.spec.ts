import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  APPLICATION_MODEL_CATALOG,
  MODEL_IDS,
} from '../../../../src/ai/models/model-catalog';
import {
  EMBEDDING_MODEL,
  OpenAiEmbeddingAdapter,
} from '../../../../src/features/knowledge/adapters/openai-embedding.adapter';
import { EMBEDDING_DIMENSIONS } from '../../../../src/features/knowledge/knowledge.types';

describe('OpenAiEmbeddingAdapter model catalog integration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the catalog provider identity and dimensions in the provider request', async () => {
    const catalogModel = APPLICATION_MODEL_CATALOG.embeddingModel(
      MODEL_IDS.openAiTextEmbedding3Small,
    );
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              index: 0,
              embedding: Array.from(
                { length: EMBEDDING_DIMENSIONS },
                () => 0.1,
              ),
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const runtimeConfig = {
      secret: jest.fn(() => Promise.resolve('test-only-api-key')),
    };
    const adapter = new OpenAiEmbeddingAdapter(runtimeConfig as never);

    await expect(adapter.embed(['catalog-backed'])).resolves.toHaveLength(1);

    expect(EMBEDDING_MODEL).toBe(catalogModel.providerModelId);
    expect(adapter.model).toBe(catalogModel.providerModelId);
    expect(adapter.dimensions).toBe(catalogModel.dimensions);
    const request = fetchMock.mock.calls[0]?.[1];
    if (typeof request?.body !== 'string') {
      throw new Error('Expected a serialized JSON request body');
    }
    expect(JSON.parse(request.body)).toEqual({
      model: catalogModel.providerModelId,
      input: ['catalog-backed'],
    });
  });
});
