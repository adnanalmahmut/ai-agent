import { describe, expect, it } from '@jest/globals';

import {
  APPLICATION_MODEL_CATALOG,
  MODEL_IDS,
} from '../../../../src/ai/models/model-catalog';
import { EMBEDDING_DIMENSIONS } from '../../../../src/features/knowledge/knowledge.types';

describe('application model catalog', () => {
  it('resolves the agent model to its provider and runtime identity', () => {
    expect(
      APPLICATION_MODEL_CATALOG.agentModel(MODEL_IDS.openAiGpt4oMini),
    ).toEqual({
      id: MODEL_IDS.openAiGpt4oMini,
      providerId: 'openai',
      mastraModelId: 'openai/gpt-4o-mini',
    });
  });

  it.each([
    ['an unknown stable identity', 'openai.unknown'],
    [
      'a provider alias instead of the application identity',
      'openai/gpt-4o-mini',
    ],
    ['a bare provider model name', 'gpt-4o-mini'],
    ['a floating "latest" tag', 'gpt-latest'],
    ['the embedding model', MODEL_IDS.openAiTextEmbedding3Small],
  ])('refuses %s as an agent model instead of falling back', (_case, id) => {
    expect(() => APPLICATION_MODEL_CATALOG.agentModel(id)).toThrow(
      'is not an application agent model',
    );
  });

  it('resolves the embedding model to its provider identity', () => {
    expect(
      APPLICATION_MODEL_CATALOG.embeddingModel(
        MODEL_IDS.openAiTextEmbedding3Small,
      ).providerModelId,
    ).toBe('text-embedding-3-small');

    expect(() =>
      APPLICATION_MODEL_CATALOG.embeddingModel(MODEL_IDS.openAiGpt4oMini),
    ).toThrow('is not an application embedding model');
  });

  // The pgvector column is declared `vector(1536)`. A model whose output does
  // not match that width would be rejected row by row at write time instead of
  // once, here, at boot.
  it('declares the embedding width the deployed schema stores', () => {
    expect(
      APPLICATION_MODEL_CATALOG.embeddingModel(
        MODEL_IDS.openAiTextEmbedding3Small,
      ).dimensions,
    ).toBe(EMBEDDING_DIMENSIONS);
  });

  it.each([
    [
      MODEL_IDS.openAiGpt4oMini,
      '2024-10-01T00:00:00.000Z',
      'openai.gpt-4o-mini.standard.2024-10-01',
    ],
    [
      MODEL_IDS.openAiTextEmbedding3Small,
      '2024-01-25T00:00:00.000Z',
      'openai.text-embedding-3-small.standard.2024-01-25',
    ],
  ])(
    'resolves %s at the inclusive start of its interval',
    (modelId, effectiveFrom, revisionId) => {
      const revision = APPLICATION_MODEL_CATALOG.pricingRevision(
        modelId,
        new Date(effectiveFrom),
      );

      expect(revision.id).toBe(revisionId);
      expect(revision.modelId).toBe(modelId);
    },
  );

  it('refuses the instant one millisecond before a revision takes effect', () => {
    expect(() =>
      APPLICATION_MODEL_CATALOG.pricingRevision(
        MODEL_IDS.openAiGpt4oMini,
        new Date('2024-09-30T23:59:59.999Z'),
      ),
    ).toThrow('found 0');
  });

  it('refuses a pricing lookup for a model it does not price', () => {
    expect(() =>
      APPLICATION_MODEL_CATALOG.pricingRevision(
        'openai.unknown',
        new Date('2025-01-01T00:00:00.000Z'),
      ),
    ).toThrow('found 0');
  });

  it('refuses an invalid resolution instant rather than resolving one', () => {
    expect(() =>
      APPLICATION_MODEL_CATALOG.pricingRevision(
        MODEL_IDS.openAiGpt4oMini,
        new Date('not-a-date'),
      ),
    ).toThrow('Pricing resolution instant is invalid');
  });
});
