import { AgentConfigurationError } from '../agents/agent-configuration.error';
import type {
  AgentConfiguration,
  AgentDefinition,
  AgentRun,
  AgentValue,
} from '../agents/agent.types';
import {
  APPLICATION_MODEL_CATALOG,
  type AgentModelId,
} from '../models/model-catalog';

/**
 * The model a run executes against, as three durable identities rather than
 * one name. An out-of-process runtime is told all three because none of them
 * is a question it is allowed to answer.
 */
export type ModelPin = {
  readonly policyId: string;
  readonly modelId: AgentModelId;
  readonly pricingRevisionId: string;
};

type ModelPinInput = Pick<
  AgentRun,
  'modelPolicyId' | 'modelId' | 'modelPricingRevisionId' | 'createdAt'
>;

/**
 * The model a run executes against, revalidated.
 *
 * A run predating model pinning carries none of the three identities and falls
 * back to the pinned definition's own model. The same run executed twice must
 * not silently change model, so a partially populated pin is a contradiction
 * rather than something to complete from defaults.
 */
export function resolveModelId(
  definition: AgentDefinition,
  run: ModelPinInput,
): AgentModelId {
  const identities = [
    run.modelPolicyId,
    run.modelId,
    run.modelPricingRevisionId,
  ];

  if (identities.every((value) => value === null)) return definition.model;

  if (identities.some((value) => value === null)) {
    throw new AgentConfigurationError(
      'AgentRun model pin is only partially populated',
    );
  }

  const modelId = run.modelId as AgentModelId;

  if (
    run.modelPolicyId !== definition.modelPolicy.id ||
    !definition.modelPolicy.allowedModelIds.includes(modelId)
  ) {
    throw new AgentConfigurationError(
      'AgentRun model does not satisfy its pinned definition policy',
    );
  }

  if (
    pricingRevisionFor(modelId, run.createdAt) !== run.modelPricingRevisionId
  ) {
    throw new AgentConfigurationError(
      'AgentRun model or pricing revision is unavailable for execution',
    );
  }

  return modelId;
}

/**
 * The same decision, as the three identities an execution document carries.
 *
 * A run that predates pinning has a model but no recorded revision, so the
 * document's is resolved from the catalogue here. That lookup is deliberately
 * not part of `resolveModelId`: an unpinned run executes in process today
 * without one, and this boundary must not be what starts failing it.
 */
export function resolveModelPin(
  definition: AgentDefinition,
  run: ModelPinInput,
): ModelPin {
  const modelId = resolveModelId(definition, run);

  if (run.modelPricingRevisionId === null) {
    return {
      policyId: definition.modelPolicy.id,
      modelId,
      pricingRevisionId: pricingRevisionFor(modelId, run.createdAt),
    };
  }

  return {
    policyId: run.modelPolicyId as string,
    modelId,
    pricingRevisionId: run.modelPricingRevisionId,
  };
}

function pricingRevisionFor(modelId: AgentModelId, at: Date): string {
  try {
    APPLICATION_MODEL_CATALOG.agentModel(modelId);

    return APPLICATION_MODEL_CATALOG.pricingRevision(modelId, at).id;
  } catch {
    throw new AgentConfigurationError(
      'AgentRun model or pricing revision is unavailable for execution',
    );
  }
}

/**
 * The organization configuration a run executes under, normalised by the
 * pinned definition's own contract.
 *
 * One rule in one place. The in-process runtime and the execution document
 * that describes the same work to another process must apply the same
 * defaults, trims and coercions: if they diverge, moving the runtime out of
 * process silently changes what an agent was configured to do, and nothing
 * about the change would look like a change.
 *
 * `pinned` says whether the run carries an organization version. A definition
 * with no configuration contract was never installable, so only an unpinned
 * compatibility run may reach one; a pinned run contradicts its own durable
 * identity.
 */
export function resolvePinnedConfiguration(
  definition: AgentDefinition,
  stored: AgentConfiguration | null,
  pinned: boolean,
): AgentConfiguration {
  const contract = definition.organizationConfiguration;

  if (!contract) {
    if (!pinned) return {};

    throw new AgentConfigurationError(
      `Pinned definition "${definition.id}@${definition.version}" is not installable`,
    );
  }

  try {
    return contract.schema.parse(stored ?? contract.defaultValue);
  } catch {
    throw new AgentConfigurationError(
      `AgentRun configuration does not satisfy definition "${definition.id}@${definition.version}"`,
    );
  }
}

/** Every string in the input, in order, as the text context retrieval matches on. */
export function contextQueryOf(input: AgentValue): string {
  const parts: string[] = [];

  const walk = (value: AgentValue): void => {
    if (typeof value === 'string') {
      parts.push(value);

      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item);

      return;
    }

    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item);
    }
  };

  walk(input);

  return parts.join('\n').trim();
}
