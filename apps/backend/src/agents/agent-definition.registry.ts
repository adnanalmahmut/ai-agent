import { Inject, Injectable } from '@nestjs/common';

import type { AgentDefinition } from './agent.types';

export const AGENT_DEFINITIONS = Symbol('AGENT_DEFINITIONS');

/** Explicit code-owned definitions. There is no discovery or plugin loading. */
@Injectable()
export class AgentDefinitionRegistry {
  private readonly definitions: ReadonlyMap<string, AgentDefinition>;

  constructor(
    @Inject(AGENT_DEFINITIONS) definitions: readonly AgentDefinition[],
  ) {
    const indexed = new Map<string, AgentDefinition>();

    for (const definition of definitions) {
      if (indexed.has(definition.id)) {
        throw new Error(`Duplicate agent definition "${definition.id}"`);
      }
      indexed.set(definition.id, definition);
    }

    this.definitions = indexed;
  }

  resolve(id: string): AgentDefinition {
    const definition = this.definitions.get(id);
    if (!definition)
      throw new Error(`Agent definition "${id}" is not registered`);
    return definition;
  }
}
