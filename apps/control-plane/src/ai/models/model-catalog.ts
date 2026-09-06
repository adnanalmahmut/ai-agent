/**
 * The models this application supports, and the pricing revisions its runs are
 * billed against.
 *
 * These are source-controlled static definitions, not a registry: the set
 * changes by editing this file and shipping it, so TypeScript already checks
 * everything a constructor could have re-checked at boot.
 *
 * The stable identities in `MODEL_IDS` are durable. They are persisted on
 * `AgentRun.modelId`, so they must never be renamed to a raw provider model
 * name, and an unrecognized identity must fail rather than fall back.
 */

export type ModelProviderId = 'openai';

export const MODEL_IDS = {
  openAiGpt4oMini: 'openai.gpt-4o-mini',
  openAiTextEmbedding3Small: 'openai.text-embedding-3-small',
} as const;

export type ModelId = (typeof MODEL_IDS)[keyof typeof MODEL_IDS];
export const MODEL_ID_VALUES = [
  MODEL_IDS.openAiGpt4oMini,
  MODEL_IDS.openAiTextEmbedding3Small,
] as const satisfies readonly ModelId[];
export type AgentModelId = typeof MODEL_IDS.openAiGpt4oMini;
export type EmbeddingModelId = typeof MODEL_IDS.openAiTextEmbedding3Small;

/** What MastraRuntime needs to turn a stable identity into a provider call. */
export type GenerationModelDefinition = {
  readonly id: AgentModelId;
  readonly providerId: ModelProviderId;
  readonly mastraModelId: `${ModelProviderId}/${string}`;
};

/** What the OpenAI embedding adapter needs, including the deployed vector size. */
export type EmbeddingModelDefinition = {
  readonly id: EmbeddingModelId;
  readonly providerId: ModelProviderId;
  readonly providerModelId: string;
  readonly dimensions: number;
};

/** USD micros per million tokens. */
export type GenerationTokenRates = {
  readonly uncachedInput: number;
  readonly cachedInput: number;
  readonly output: number;
};

/** USD micros per million tokens. */
export type EmbeddingTokenRates = {
  readonly input: number;
};

/**
 * A priced interval, half-open as `[effectiveFrom, effectiveTo)`. `id` is
 * durable: it is persisted on `AgentRun.modelPricingRevisionId` at acceptance
 * and re-checked at execution, so a shipped revision's identity and interval
 * must not be edited afterwards — supersede it with a new revision instead.
 */
export type ModelPricingRevision = {
  readonly id: string;
  readonly modelId: ModelId;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly rates: GenerationTokenRates | EmbeddingTokenRates;
};

export class ModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCatalogError';
  }
}

// https://developers.openai.com/api/docs/models/gpt-4o-mini
const AGENT_MODELS = {
  [MODEL_IDS.openAiGpt4oMini]: {
    id: MODEL_IDS.openAiGpt4oMini,
    providerId: 'openai',
    mastraModelId: 'openai/gpt-4o-mini',
  },
} as const satisfies Record<AgentModelId, GenerationModelDefinition>;

// https://developers.openai.com/api/docs/models/text-embedding-3-small
const EMBEDDING_MODELS = {
  [MODEL_IDS.openAiTextEmbedding3Small]: {
    id: MODEL_IDS.openAiTextEmbedding3Small,
    providerId: 'openai',
    providerModelId: 'text-embedding-3-small',
    dimensions: 1_536,
  },
} as const satisfies Record<EmbeddingModelId, EmbeddingModelDefinition>;

// Rates: https://openai.com/index/api-prompt-caching/ and
// https://openai.com/index/new-embedding-models-and-api-updates/
const PRICING_REVISIONS = [
  {
    id: 'openai.gpt-4o-mini.standard.2024-10-01',
    modelId: MODEL_IDS.openAiGpt4oMini,
    effectiveFrom: '2024-10-01T00:00:00.000Z',
    effectiveTo: null,
    rates: { uncachedInput: 150_000, cachedInput: 75_000, output: 600_000 },
  },
  {
    id: 'openai.text-embedding-3-small.standard.2024-01-25',
    modelId: MODEL_IDS.openAiTextEmbedding3Small,
    effectiveFrom: '2024-01-25T00:00:00.000Z',
    effectiveTo: null,
    rates: { input: 20_000 },
  },
] as const satisfies readonly ModelPricingRevision[];

/**
 * Exported as one object rather than as free functions on purpose: under this
 * package's ESM Jest configuration a module namespace is read-only, so a free
 * function cannot be spied. The AgentRun e2e suite spies `pricingRevision` to
 * prove the revision is resolved at the *acceptance* instant — evidence that no
 * black-box assertion can reproduce while each model has a single open-ended
 * revision.
 */
export const APPLICATION_MODEL_CATALOG = {
  agentModel(id: string): GenerationModelDefinition {
    const model = (AGENT_MODELS as Record<string, GenerationModelDefinition>)[
      id
    ];
    if (!model) {
      throw new ModelCatalogError(
        `Model "${id}" is not an application agent model`,
      );
    }
    return model;
  },

  embeddingModel(id: string): EmbeddingModelDefinition {
    const model = (
      EMBEDDING_MODELS as Record<string, EmbeddingModelDefinition>
    )[id];
    if (!model) {
      throw new ModelCatalogError(
        `Model "${id}" is not an application embedding model`,
      );
    }
    return model;
  },

  /**
   * Resolves the revision covering `at`. Exactly one match is required, so an
   * ambiguous or missing interval fails loudly instead of picking a neighbour.
   */
  pricingRevision(modelId: string, at: Date): ModelPricingRevision {
    const instant = at.getTime();
    if (!Number.isFinite(instant)) {
      throw new ModelCatalogError('Pricing resolution instant is invalid');
    }

    const matches = PRICING_REVISIONS.filter(
      (revision) =>
        revision.modelId === modelId &&
        Date.parse(revision.effectiveFrom) <= instant &&
        (revision.effectiveTo === null ||
          instant < Date.parse(revision.effectiveTo)),
    );

    if (matches.length !== 1) {
      throw new ModelCatalogError(
        `Expected exactly one pricing revision for model "${modelId}" at "${at.toISOString()}", found ${matches.length}`,
      );
    }

    return matches[0];
  },
};
