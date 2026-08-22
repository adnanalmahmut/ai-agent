import { Inject, Injectable } from '@nestjs/common';

import { AgentConfigurationError } from './agent-configuration.error';
import type { AgentDefinition } from './agent.types';

export const AGENT_DEFINITIONS = Symbol('AGENT_DEFINITIONS');

function key(id: string, version: number): string {
  return `${id}@${version}`;
}

/** Explicit code-owned definitions. There is no discovery or plugin loading. */
@Injectable()
export class AgentDefinitionRegistry {
  private readonly definitions: ReadonlyMap<string, AgentDefinition>;

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
}
