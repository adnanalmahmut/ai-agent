import { Inject, Injectable } from '@nestjs/common';

import { AgentConfigurationError } from './agent-configuration.error';
import type { AgentConfiguration, AgentDefinition } from './agent.types';
import { APPLICATION_MODEL_CATALOG } from '../model-catalog/model-catalog';

export const AGENT_DEFINITIONS = Symbol('AGENT_DEFINITIONS');

function key(id: string, version: number): string {
  return `${id}@${version}`;
}

/** Explicit code-owned definitions. There is no discovery or plugin loading. */
@Injectable()
export class AgentDefinitionRegistry {
  private readonly definitions: ReadonlyMap<string, AgentDefinition>;
  private readonly registered: readonly AgentDefinition[];

  constructor(
    @Inject(AGENT_DEFINITIONS) definitions: readonly AgentDefinition[],
  ) {
    const indexed = new Map<string, AgentDefinition>();
    const policyIds = new Set<string>();

    for (const definition of definitions) {
      const identity = key(definition.id, definition.version);

      // Two definitions claiming one `(id, version)` make the pair meaningless
      // as durable identity, and an AgentRun pinned to it would resolve to
      // whichever happened to be registered last. Fail at composition rather
      // than let that reach a worker.
      if (indexed.has(identity)) {
        throw new Error(`Duplicate agent definition "${identity}"`);
      }
      validateModelPolicy(definition, policyIds);
      const registered = immutableDefinition(definition);
      indexed.set(identity, registered);
    }

    this.definitions = indexed;
    this.registered = [...indexed.values()];
  }

  /**
   * Resolves the exact pinned revision. There is deliberately no fallback to a
   * latest version: silently running newer code for a run accepted against an
   * older definition is the drift this pairing exists to prevent.
   *
   * An unregistered pair is an `AgentConfigurationError`, not a plain one. The
   * registry is built from code at startup, so the answer cannot change between
   * a first attempt and a third — retrying only postpones the report.
   */
  resolve(id: string, version: number): AgentDefinition {
    const identity = key(id, version);
    const definition = this.definitions.get(identity);
    if (!definition)
      throw new AgentConfigurationError(
        `Agent definition "${identity}" is not registered`,
      );
    return definition;
  }

  /** Latest installable revision of every code-owned agent, stable by id. */
  listInstallable(): readonly AgentDefinition[] {
    const latest = new Map<string, AgentDefinition>();

    for (const definition of this.registered) {
      if (!definition.organizationConfiguration) continue;
      const current = latest.get(definition.id);
      if (!current || definition.version > current.version) {
        latest.set(definition.id, definition);
      }
    }

    return [...latest.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  /**
   * Parses configuration against the exact requested definition revision.
   * There is no fallback to latest and no runtime-owned validation path.
   */
  parseOrganizationConfiguration(
    id: string,
    version: number,
    value: unknown,
  ): AgentConfiguration {
    const definition = this.resolve(id, version);
    const contract = definition.organizationConfiguration;

    if (!contract) {
      throw new AgentConfigurationError(
        `Agent definition "${id}@${version}" is not installable`,
      );
    }

    return contract.schema.parse(value ?? contract.defaultValue);
  }
}

function immutableDefinition(definition: AgentDefinition): AgentDefinition {
  const allowedModelIds = Object.freeze([
    ...definition.modelPolicy.allowedModelIds,
  ]);
  const modelPolicy = Object.freeze({
    id: definition.modelPolicy.id,
    allowedModelIds,
  });
  return Object.freeze({ ...definition, modelPolicy });
}

function validateModelPolicy(
  definition: AgentDefinition,
  policyIds: Set<string>,
): void {
  const { modelPolicy } = definition;
  if (
    !modelPolicy ||
    typeof modelPolicy.id !== 'string' ||
    modelPolicy.id.trim() !== modelPolicy.id ||
    modelPolicy.id.length === 0
  ) {
    throw new Error(
      `Agent definition "${definition.id}@${definition.version}" has an invalid model policy identity`,
    );
  }
  if (policyIds.has(modelPolicy.id)) {
    throw new Error(`Duplicate agent model policy "${modelPolicy.id}"`);
  }
  policyIds.add(modelPolicy.id);

  if (modelPolicy.allowedModelIds.length === 0) {
    throw new Error(`Agent model policy "${modelPolicy.id}" allows no models`);
  }
  const allowed = new Set(modelPolicy.allowedModelIds);
  if (allowed.size !== modelPolicy.allowedModelIds.length) {
    throw new Error(
      `Agent model policy "${modelPolicy.id}" contains duplicate models`,
    );
  }
  if (!allowed.has(definition.model)) {
    throw new Error(
      `Agent model policy "${modelPolicy.id}" does not allow its default model`,
    );
  }
  for (const modelId of allowed) {
    try {
      APPLICATION_MODEL_CATALOG.agentModel(modelId);
    } catch {
      throw new Error(
        `Agent model policy "${modelPolicy.id}" names a model unavailable for agent execution`,
      );
    }
  }
}
