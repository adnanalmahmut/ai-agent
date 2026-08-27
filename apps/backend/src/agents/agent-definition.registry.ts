import { Inject, Injectable } from '@nestjs/common';

import { AgentConfigurationError } from './agent-configuration.error';
import type { AgentConfiguration, AgentDefinition } from './agent.types';

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

    for (const definition of definitions) {
      const identity = key(definition.id, definition.version);

      // Two definitions claiming one `(id, version)` make the pair meaningless
      // as durable identity, and an AgentRun pinned to it would resolve to
      // whichever happened to be registered last. Fail at composition rather
      // than let that reach a worker.
      if (indexed.has(identity)) {
        throw new Error(`Duplicate agent definition "${identity}"`);
      }
      indexed.set(identity, definition);
    }

    this.definitions = indexed;
    this.registered = [...definitions];
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
