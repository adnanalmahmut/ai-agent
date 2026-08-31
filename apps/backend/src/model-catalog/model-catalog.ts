/**
 * The provider and model vocabulary this application is prepared to use.
 *
 * This is operational application policy, not provider discovery. A provider
 * publishing a new model or changing a price does not change what this build
 * can select; both require a reviewed code revision.
 */

export const MODEL_PROVIDER_IDS = {
  openai: 'openai',
} as const;

export type ModelProviderId =
  (typeof MODEL_PROVIDER_IDS)[keyof typeof MODEL_PROVIDER_IDS];

export const MODEL_IDS = {
  openAiGpt4oMini: 'openai.gpt-4o-mini',
  openAiTextEmbedding3Small: 'openai.text-embedding-3-small',
} as const;

export type ModelId = (typeof MODEL_IDS)[keyof typeof MODEL_IDS];
export type AgentModelId = typeof MODEL_IDS.openAiGpt4oMini;
export type EmbeddingModelId = typeof MODEL_IDS.openAiTextEmbedding3Small;

type ModelIdentity = {
  /** Stable application identity. Never silently aliases another entry. */
  readonly id: ModelId;
  readonly providerId: ModelProviderId;
  /** Exact identifier sent to the provider API. */
  readonly providerModelId: string;
  readonly source: {
    readonly url: string;
    readonly retrievedAt: string;
  };
};

export type GenerationModelDefinition = ModelIdentity & {
  readonly kind: 'generation';
  /** Capabilities the current application actually exposes and enforces. */
  readonly capabilities: {
    readonly inputModalities: readonly ['text'];
    readonly outputModalities: readonly ['text'];
    readonly contextWindowTokens: number;
    readonly maxOutputTokens: number;
    readonly structuredOutput: true;
    readonly runtimeCompatibility: readonly ['mastra'];
  };
  /** Exact model-router identity handed to the replaceable Mastra adapter. */
  readonly mastraModelId: `${ModelProviderId}/${string}`;
};

export type EmbeddingModelDefinition = ModelIdentity & {
  readonly kind: 'embedding';
  readonly capabilities: {
    readonly inputModalities: readonly ['text'];
    readonly outputModalities: readonly ['embedding'];
    readonly dimensions: number;
    readonly adapterCompatibility: readonly ['openai-embeddings'];
  };
};

export type ModelDefinition =
  GenerationModelDefinition | EmbeddingModelDefinition;

export type GenerationTokenRates = {
  readonly uncachedInput: number;
  readonly cachedInput: number;
  readonly output: number;
};

export type EmbeddingTokenRates = {
  readonly input: number;
};

type PricingRevisionBase = {
  /** Stable historical identity pinned by later lifecycle work. */
  readonly id: string;
  readonly modelId: ModelId;
  /** Inclusive ISO instant. */
  readonly effectiveFrom: string;
  /** Exclusive ISO instant; null means the revision remains current. */
  readonly effectiveTo: string | null;
  readonly currency: 'USD';
  readonly unit: 'USD_MICROS_PER_MILLION_TOKENS';
  readonly source: {
    readonly url: string;
    readonly retrievedAt: string;
  };
};

export type GenerationPricingRevision = PricingRevisionBase & {
  readonly kind: 'generation';
  readonly rates: GenerationTokenRates;
};

export type EmbeddingPricingRevision = PricingRevisionBase & {
  readonly kind: 'embedding';
  readonly rates: EmbeddingTokenRates;
};

export type ModelPricingRevision =
  GenerationPricingRevision | EmbeddingPricingRevision;

export class ModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCatalogError';
  }
}

/**
 * A bounded, in-memory code catalog with exact lookup and interval validation.
 *
 * The constructor is public so focused tests can prove malformed application
 * policy is refused. It is not a dynamic registration surface: production
 * constructs exactly one instance from the constants below at module load.
 */
export class ModelCatalog {
  private readonly modelsById: ReadonlyMap<string, ModelDefinition>;
  private readonly modelsByProviderIdentity: ReadonlyMap<
    string,
    ModelDefinition
  >;
  private readonly pricingByModel: ReadonlyMap<
    ModelId,
    readonly ModelPricingRevision[]
  >;

  constructor(
    models: readonly ModelDefinition[],
    pricing: readonly ModelPricingRevision[],
  ) {
    const modelsById = new Map<string, ModelDefinition>();
    const modelsByProviderIdentity = new Map<string, ModelDefinition>();

    for (const candidate of models) {
      const model = immutableCopy(candidate);
      if (modelsById.has(model.id)) {
        throw new ModelCatalogError(`Duplicate model identity "${model.id}"`);
      }

      const providerIdentity = providerModelKey(
        model.providerId,
        model.providerModelId,
      );
      if (modelsByProviderIdentity.has(providerIdentity)) {
        throw new ModelCatalogError(
          `Duplicate provider model identity "${providerIdentity}"`,
        );
      }

      validateModel(model);
      modelsById.set(model.id, model);
      modelsByProviderIdentity.set(providerIdentity, model);
    }

    const pricingByModel = new Map<ModelId, ModelPricingRevision[]>();
    const revisionIds = new Set<string>();

    for (const candidate of pricing) {
      const revision = immutableCopy(candidate);
      if (revisionIds.has(revision.id)) {
        throw new ModelCatalogError(
          `Duplicate pricing revision identity "${revision.id}"`,
        );
      }
      revisionIds.add(revision.id);

      const model = modelsById.get(revision.modelId);
      if (!model) {
        throw new ModelCatalogError(
          `Pricing revision "${revision.id}" names unknown model "${revision.modelId}"`,
        );
      }
      if (revision.kind !== model.kind) {
        throw new ModelCatalogError(
          `Pricing revision "${revision.id}" does not match model kind "${model.kind}"`,
        );
      }

      validatePricingRevision(revision);
      const revisions = pricingByModel.get(revision.modelId) ?? [];
      revisions.push(revision);
      pricingByModel.set(revision.modelId, revisions);
    }

    for (const [modelId, revisions] of pricingByModel) {
      revisions.sort(
        (left, right) =>
          instant(left.effectiveFrom) - instant(right.effectiveFrom),
      );
      validateNoOverlap(modelId, revisions);
    }

    this.modelsById = modelsById;
    this.modelsByProviderIdentity = modelsByProviderIdentity;
    this.pricingByModel = pricingByModel;
  }

  model(id: string): ModelDefinition {
    const model = this.modelsById.get(id);
    if (!model) {
      throw new ModelCatalogError(
        `Model "${id}" is not in the application catalog`,
      );
    }
    return model;
  }

  providerModel(providerId: string, providerModelId: string): ModelDefinition {
    const identity = providerModelKey(providerId, providerModelId);
    const model = this.modelsByProviderIdentity.get(identity);
    if (!model) {
      throw new ModelCatalogError(
        `Provider model "${identity}" is not in the application catalog`,
      );
    }
    return model;
  }

  /** The exact capability contract every current AgentDefinition requires. */
  agentModel(id: string): GenerationModelDefinition {
    const model = this.model(id);
    if (
      model.kind !== 'generation' ||
      !model.capabilities.structuredOutput ||
      !model.capabilities.inputModalities.includes('text') ||
      !model.capabilities.outputModalities.includes('text') ||
      !model.capabilities.runtimeCompatibility.includes('mastra')
    ) {
      throw new ModelCatalogError(
        `Model "${id}" does not satisfy the application agent-model contract`,
      );
    }
    return model;
  }

  /** The exact capability contract the deployed knowledge adapter requires. */
  embeddingModel(id: string): EmbeddingModelDefinition {
    const model = this.model(id);
    if (
      model.kind !== 'embedding' ||
      !model.capabilities.inputModalities.includes('text') ||
      !model.capabilities.outputModalities.includes('embedding') ||
      !Number.isSafeInteger(model.capabilities.dimensions) ||
      model.capabilities.dimensions <= 0 ||
      !model.capabilities.adapterCompatibility.includes('openai-embeddings')
    ) {
      throw new ModelCatalogError(
        `Model "${id}" does not satisfy the application embedding-model contract`,
      );
    }
    return model;
  }

  /** Resolves the one half-open pricing interval containing `at`. */
  pricingRevision(modelId: string, at: Date): ModelPricingRevision {
    const model = this.model(modelId);
    const atInstant = at.getTime();
    if (!Number.isFinite(atInstant)) {
      throw new ModelCatalogError('Pricing resolution instant is invalid');
    }

    const matches = (this.pricingByModel.get(model.id) ?? []).filter(
      (revision) =>
        instant(revision.effectiveFrom) <= atInstant &&
        (revision.effectiveTo === null ||
          atInstant < instant(revision.effectiveTo)),
    );

    if (matches.length !== 1) {
      throw new ModelCatalogError(
        `Expected exactly one pricing revision for model "${modelId}" at "${at.toISOString()}", found ${matches.length}`,
      );
    }

    return matches[0];
  }
}

const MODELS = [
  {
    id: MODEL_IDS.openAiGpt4oMini,
    providerId: MODEL_PROVIDER_IDS.openai,
    providerModelId: 'gpt-4o-mini',
    source: {
      url: 'https://developers.openai.com/api/docs/models/gpt-4o-mini',
      retrievedAt: '2026-08-27',
    },
    kind: 'generation',
    capabilities: {
      inputModalities: ['text'],
      outputModalities: ['text'],
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      structuredOutput: true,
      runtimeCompatibility: ['mastra'],
    },
    mastraModelId: 'openai/gpt-4o-mini',
  },
  {
    id: MODEL_IDS.openAiTextEmbedding3Small,
    providerId: MODEL_PROVIDER_IDS.openai,
    providerModelId: 'text-embedding-3-small',
    source: {
      url: 'https://developers.openai.com/api/docs/models/text-embedding-3-small',
      retrievedAt: '2026-08-27',
    },
    kind: 'embedding',
    capabilities: {
      inputModalities: ['text'],
      outputModalities: ['embedding'],
      dimensions: 1_536,
      adapterCompatibility: ['openai-embeddings'],
    },
  },
] as const satisfies readonly ModelDefinition[];

const PRICING = [
  {
    id: 'openai.gpt-4o-mini.standard.2024-10-01',
    modelId: MODEL_IDS.openAiGpt4oMini,
    kind: 'generation',
    effectiveFrom: '2024-10-01T00:00:00.000Z',
    effectiveTo: null,
    currency: 'USD',
    unit: 'USD_MICROS_PER_MILLION_TOKENS',
    rates: {
      uncachedInput: 150_000,
      cachedInput: 75_000,
      output: 600_000,
    },
    source: {
      url: 'https://openai.com/index/api-prompt-caching/',
      retrievedAt: '2026-08-27',
    },
  },
  {
    id: 'openai.text-embedding-3-small.standard.2024-01-25',
    modelId: MODEL_IDS.openAiTextEmbedding3Small,
    kind: 'embedding',
    effectiveFrom: '2024-01-25T00:00:00.000Z',
    effectiveTo: null,
    currency: 'USD',
    unit: 'USD_MICROS_PER_MILLION_TOKENS',
    rates: { input: 20_000 },
    source: {
      url: 'https://openai.com/index/new-embedding-models-and-api-updates/',
      retrievedAt: '2026-08-27',
    },
  },
] as const satisfies readonly ModelPricingRevision[];

export const APPLICATION_MODEL_CATALOG = new ModelCatalog(MODELS, PRICING);

function providerModelKey(providerId: string, providerModelId: string): string {
  return `${providerId}/${providerModelId}`;
}

function validateModel(model: ModelDefinition): void {
  if (
    model.providerModelId.trim() !== model.providerModelId ||
    !model.providerModelId
  ) {
    throw new ModelCatalogError(
      `Model "${model.id}" has an invalid provider model identity`,
    );
  }

  if (model.kind === 'generation') {
    const expectedMastraId = providerModelKey(
      model.providerId,
      model.providerModelId,
    );
    if (model.mastraModelId !== expectedMastraId) {
      throw new ModelCatalogError(
        `Model "${model.id}" has Mastra identity "${model.mastraModelId}" instead of "${expectedMastraId}"`,
      );
    }
    if (
      !Number.isSafeInteger(model.capabilities.contextWindowTokens) ||
      model.capabilities.contextWindowTokens <= 0 ||
      !Number.isSafeInteger(model.capabilities.maxOutputTokens) ||
      model.capabilities.maxOutputTokens <= 0 ||
      model.capabilities.maxOutputTokens >
        model.capabilities.contextWindowTokens
    ) {
      throw new ModelCatalogError(
        `Model "${model.id}" has invalid token-window capabilities`,
      );
    }
    if (!model.capabilities.structuredOutput) {
      throw new ModelCatalogError(
        `Model "${model.id}" cannot satisfy structured AgentDefinition output`,
      );
    }

    if (
      !model.capabilities.inputModalities.includes('text') ||
      !model.capabilities.outputModalities.includes('text') ||
      !model.capabilities.runtimeCompatibility.includes('mastra')
    ) {
      throw new ModelCatalogError(
        `Model "${model.id}" does not satisfy the application agent-model contract`,
      );
    }

    return;
  }

  if (
    !model.capabilities.inputModalities.includes('text') ||
    !model.capabilities.outputModalities.includes('embedding') ||
    !Number.isSafeInteger(model.capabilities.dimensions) ||
    model.capabilities.dimensions <= 0 ||
    !model.capabilities.adapterCompatibility.includes('openai-embeddings')
  ) {
    throw new ModelCatalogError(
      `Model "${model.id}" does not satisfy the application embedding-model contract`,
    );
  }
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }

  return value;
}

function validatePricingRevision(revision: ModelPricingRevision): void {
  const from = instant(revision.effectiveFrom);
  const to =
    revision.effectiveTo === null ? null : instant(revision.effectiveTo);
  if (to !== null && from >= to) {
    throw new ModelCatalogError(
      `Pricing revision "${revision.id}" has an empty or reversed interval`,
    );
  }

  for (const rate of Object.values(revision.rates)) {
    if (!Number.isSafeInteger(rate) || rate <= 0) {
      throw new ModelCatalogError(
        `Pricing revision "${revision.id}" has an invalid token rate`,
      );
    }
  }
}

function validateNoOverlap(
  modelId: ModelId,
  revisions: readonly ModelPricingRevision[],
): void {
  for (let index = 1; index < revisions.length; index += 1) {
    const previous = revisions[index - 1];
    const current = revisions[index];
    const previousEnd =
      previous.effectiveTo === null
        ? Number.POSITIVE_INFINITY
        : instant(previous.effectiveTo);

    if (previousEnd > instant(current.effectiveFrom)) {
      throw new ModelCatalogError(
        `Pricing revisions for model "${modelId}" overlap: "${previous.id}" and "${current.id}"`,
      );
    }
  }
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new ModelCatalogError(`Invalid ISO pricing instant "${value}"`);
  }
  return parsed;
}
