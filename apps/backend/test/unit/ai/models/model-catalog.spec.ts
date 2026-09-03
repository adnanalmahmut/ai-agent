import { describe, expect, it } from '@jest/globals';

import {
  APPLICATION_MODEL_CATALOG,
  MODEL_IDS,
  ModelCatalog,
  type EmbeddingModelDefinition,
  type GenerationModelDefinition,
  type GenerationPricingRevision,
  type ModelDefinition,
  type ModelPricingRevision,
} from '../../../../src/ai/models/model-catalog';

const productionModels = (): readonly ModelDefinition[] => [
  APPLICATION_MODEL_CATALOG.model(MODEL_IDS.openAiGpt4oMini),
  APPLICATION_MODEL_CATALOG.model(MODEL_IDS.openAiTextEmbedding3Small),
];

const generationModel = (): GenerationModelDefinition =>
  structuredClone(
    APPLICATION_MODEL_CATALOG.agentModel(MODEL_IDS.openAiGpt4oMini),
  );

const embeddingModel = (): EmbeddingModelDefinition =>
  structuredClone(
    APPLICATION_MODEL_CATALOG.embeddingModel(
      MODEL_IDS.openAiTextEmbedding3Small,
    ),
  );

const generationPrice = (
  input: Partial<GenerationPricingRevision> &
    Pick<GenerationPricingRevision, 'id' | 'effectiveFrom' | 'effectiveTo'>,
): GenerationPricingRevision => ({
  modelId: MODEL_IDS.openAiGpt4oMini,
  kind: 'generation',
  currency: 'USD',
  unit: 'USD_MICROS_PER_MILLION_TOKENS',
  rates: { uncachedInput: 1, cachedInput: 1, output: 1 },
  source: { url: 'https://example.test/price', retrievedAt: '2026-08-27' },
  ...input,
});

describe('ModelCatalog', () => {
  it('resolves exact stable and provider identities', () => {
    expect(
      APPLICATION_MODEL_CATALOG.model(MODEL_IDS.openAiGpt4oMini),
    ).toMatchObject({
      id: MODEL_IDS.openAiGpt4oMini,
      providerId: 'openai',
      providerModelId: 'gpt-4o-mini',
      kind: 'generation',
      mastraModelId: 'openai/gpt-4o-mini',
    });

    expect(
      APPLICATION_MODEL_CATALOG.providerModel('openai', 'gpt-4o-mini'),
    ).toBe(APPLICATION_MODEL_CATALOG.model(MODEL_IDS.openAiGpt4oMini));
  });

  it.each([
    [
      'unknown stable identity',
      () => APPLICATION_MODEL_CATALOG.model('openai.unknown'),
    ],
    [
      'unknown provider',
      () =>
        APPLICATION_MODEL_CATALOG.providerModel('some-provider', 'gpt-4o-mini'),
    ],
    [
      'unknown model',
      () => APPLICATION_MODEL_CATALOG.providerModel('openai', 'gpt-latest'),
    ],
    [
      'provider alias instead of the exact application identity',
      () => APPLICATION_MODEL_CATALOG.model('openai/gpt-4o-mini'),
    ],
  ])('refuses %s without falling back', (_case, lookup) => {
    expect(lookup).toThrow('not in the application catalog');
  });

  it('enforces the capabilities of each current application boundary', () => {
    const agentModel = APPLICATION_MODEL_CATALOG.agentModel(
      MODEL_IDS.openAiGpt4oMini,
    );
    expect(agentModel.capabilities).toEqual({
      inputModalities: ['text'],
      outputModalities: ['text'],
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      structuredOutput: true,
      runtimeCompatibility: ['mastra'],
    });

    expect(() =>
      APPLICATION_MODEL_CATALOG.agentModel(MODEL_IDS.openAiTextEmbedding3Small),
    ).toThrow('does not satisfy the application agent-model contract');

    expect(
      APPLICATION_MODEL_CATALOG.embeddingModel(
        MODEL_IDS.openAiTextEmbedding3Small,
      ).capabilities.dimensions,
    ).toBe(1_536);
    expect(() =>
      APPLICATION_MODEL_CATALOG.embeddingModel(MODEL_IDS.openAiGpt4oMini),
    ).toThrow('does not satisfy the application embedding-model contract');
  });

  it.each([
    [
      'text input',
      (model: GenerationModelDefinition) => {
        (
          model.capabilities as { inputModalities: readonly string[] }
        ).inputModalities = [];
      },
    ],
    [
      'text output',
      (model: GenerationModelDefinition) => {
        (
          model.capabilities as { outputModalities: readonly string[] }
        ).outputModalities = [];
      },
    ],
    [
      'Mastra compatibility',
      (model: GenerationModelDefinition) => {
        (
          model.capabilities as { runtimeCompatibility: readonly string[] }
        ).runtimeCompatibility = [];
      },
    ],
  ])('refuses an agent model without %s', (_case, mutate) => {
    const model = generationModel();
    mutate(model);
    expect(() => new ModelCatalog([model], [])).toThrow(
      'does not satisfy the application agent-model contract',
    );
  });

  it('refuses a generation model without structured output', () => {
    const model = generationModel();
    (model.capabilities as { structuredOutput: boolean }).structuredOutput =
      false;

    expect(() => new ModelCatalog([model], [])).toThrow(
      'cannot satisfy structured AgentDefinition output',
    );
  });

  it.each([
    [
      'text input',
      (model: EmbeddingModelDefinition) => {
        (
          model.capabilities as { inputModalities: readonly string[] }
        ).inputModalities = [];
      },
    ],
    [
      'embedding output',
      (model: EmbeddingModelDefinition) => {
        (
          model.capabilities as { outputModalities: readonly string[] }
        ).outputModalities = [];
      },
    ],
    [
      'positive dimensions',
      (model: EmbeddingModelDefinition) => {
        (model.capabilities as { dimensions: number }).dimensions = 0;
      },
    ],
    [
      'OpenAI adapter compatibility',
      (model: EmbeddingModelDefinition) => {
        (
          model.capabilities as { adapterCompatibility: readonly string[] }
        ).adapterCompatibility = [];
      },
    ],
  ])('refuses an embedding model without %s', (_case, mutate) => {
    const model = embeddingModel();
    mutate(model);
    expect(() => new ModelCatalog([model], [])).toThrow(
      'does not satisfy the application embedding-model contract',
    );
  });

  it('keeps model and pricing history immutable across lookups', () => {
    const model = APPLICATION_MODEL_CATALOG.agentModel(
      MODEL_IDS.openAiGpt4oMini,
    );
    const revision = APPLICATION_MODEL_CATALOG.pricingRevision(
      model.id,
      new Date('2024-10-01T00:00:00.000Z'),
    );

    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.capabilities)).toBe(true);
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision.rates)).toBe(true);
    expect(() => {
      (revision.rates as { output?: number }).output = 1;
    }).toThrow(TypeError);
    expect(
      APPLICATION_MODEL_CATALOG.pricingRevision(
        model.id,
        new Date('2024-10-01T00:00:00.000Z'),
      ),
    ).toMatchObject({ rates: { output: 600_000 } });
  });

  it('resolves the documented production revisions at their inclusive boundaries', () => {
    expect(
      APPLICATION_MODEL_CATALOG.pricingRevision(
        MODEL_IDS.openAiGpt4oMini,
        new Date('2024-10-01T00:00:00.000Z'),
      ),
    ).toMatchObject({
      id: 'openai.gpt-4o-mini.standard.2024-10-01',
      rates: {
        uncachedInput: 150_000,
        cachedInput: 75_000,
        output: 600_000,
      },
      source: { retrievedAt: '2026-08-27' },
    });

    expect(
      APPLICATION_MODEL_CATALOG.pricingRevision(
        MODEL_IDS.openAiTextEmbedding3Small,
        new Date('2024-01-25T00:00:00.000Z'),
      ),
    ).toMatchObject({
      id: 'openai.text-embedding-3-small.standard.2024-01-25',
      rates: { input: 20_000 },
      source: { retrievedAt: '2026-08-27' },
    });
  });

  it('refuses an instant before the earliest evidenced revision', () => {
    expect(() =>
      APPLICATION_MODEL_CATALOG.pricingRevision(
        MODEL_IDS.openAiGpt4oMini,
        new Date('2024-09-30T23:59:59.999Z'),
      ),
    ).toThrow('found 0');
  });

  it('uses half-open boundaries between adjacent revisions', () => {
    const catalog = new ModelCatalog(productionModels(), [
      generationPrice({
        id: 'revision-a',
        effectiveFrom: '2024-01-01T00:00:00.000Z',
        effectiveTo: '2025-01-01T00:00:00.000Z',
      }),
      generationPrice({
        id: 'revision-b',
        effectiveFrom: '2025-01-01T00:00:00.000Z',
        effectiveTo: null,
      }),
    ]);

    expect(
      catalog.pricingRevision(
        MODEL_IDS.openAiGpt4oMini,
        new Date('2024-12-31T23:59:59.999Z'),
      ).id,
    ).toBe('revision-a');
    expect(
      catalog.pricingRevision(
        MODEL_IDS.openAiGpt4oMini,
        new Date('2025-01-01T00:00:00.000Z'),
      ).id,
    ).toBe('revision-b');
  });

  it('refuses every instant in a gap instead of falling back to a nearby revision', () => {
    const catalog = new ModelCatalog(productionModels(), [
      generationPrice({
        id: 'revision-a',
        effectiveFrom: '2024-01-01T00:00:00.000Z',
        effectiveTo: '2024-06-01T00:00:00.000Z',
      }),
      generationPrice({
        id: 'revision-b',
        effectiveFrom: '2024-07-01T00:00:00.000Z',
        effectiveTo: '2025-01-01T00:00:00.000Z',
      }),
    ]);

    for (const instant of [
      '2024-06-01T00:00:00.000Z',
      '2024-06-15T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
    ]) {
      expect(() =>
        catalog.pricingRevision(MODEL_IDS.openAiGpt4oMini, new Date(instant)),
      ).toThrow('found 0');
    }

    expect(
      catalog.pricingRevision(
        MODEL_IDS.openAiGpt4oMini,
        new Date('2024-07-01T00:00:00.000Z'),
      ).id,
    ).toBe('revision-b');
  });

  it('refuses overlapping or ambiguous price revisions at construction', () => {
    expect(
      () =>
        new ModelCatalog(productionModels(), [
          generationPrice({
            id: 'revision-a',
            effectiveFrom: '2024-01-01T00:00:00.000Z',
            effectiveTo: '2025-01-02T00:00:00.000Z',
          }),
          generationPrice({
            id: 'revision-b',
            effectiveFrom: '2025-01-01T00:00:00.000Z',
            effectiveTo: null,
          }),
        ]),
    ).toThrow('overlap');
  });

  it.each([
    [
      'duplicate revision identity',
      [
        generationPrice({
          id: 'same-revision',
          effectiveFrom: '2024-01-01T00:00:00.000Z',
          effectiveTo: '2025-01-01T00:00:00.000Z',
        }),
        generationPrice({
          id: 'same-revision',
          effectiveFrom: '2025-01-01T00:00:00.000Z',
          effectiveTo: null,
        }),
      ],
    ],
    [
      'reversed interval',
      [
        generationPrice({
          id: 'reversed',
          effectiveFrom: '2025-01-01T00:00:00.000Z',
          effectiveTo: '2024-01-01T00:00:00.000Z',
        }),
      ],
    ],
    [
      'non-positive token rate',
      [
        generationPrice({
          id: 'bad-rate',
          effectiveFrom: '2024-01-01T00:00:00.000Z',
          effectiveTo: null,
          rates: { uncachedInput: 1, cachedInput: 1, output: 0 },
        }),
      ],
    ],
  ] satisfies readonly [string, readonly ModelPricingRevision[]][])(
    'refuses %s',
    (_case, revisions) => {
      expect(() => new ModelCatalog(productionModels(), revisions)).toThrow();
    },
  );

  it('refuses a price revision for an unknown model', () => {
    const revision = generationPrice({
      id: 'unknown-model-price',
      effectiveFrom: '2024-01-01T00:00:00.000Z',
      effectiveTo: null,
    });

    expect(
      () =>
        new ModelCatalog(productionModels(), [
          {
            ...revision,
            modelId: 'openai.unknown',
          } as unknown as ModelPricingRevision,
        ]),
    ).toThrow('names unknown model');
  });
});
