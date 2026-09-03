import { Inject, Injectable } from '@nestjs/common';

import { RUNTIME_TOOL_NAME_PATTERN } from '../agents/agent.types';
import {
  TOOL_REFS,
  TOOL_RISKS,
  isToolRef,
  toolRef,
  type ToolDefinition,
  type ToolRef,
} from './tool.types';

export const TOOL_DEFINITIONS = Symbol('TOOL_DEFINITIONS');

@Injectable()
export class ToolRegistry {
  private readonly byRef: ReadonlyMap<ToolRef, ToolDefinition>;

  constructor(
    @Inject(TOOL_DEFINITIONS) definitions: readonly ToolDefinition[],
  ) {
    const indexed = new Map<ToolRef, ToolDefinition>();
    const runtimeNames = new Set<string>();

    for (const definition of definitions) {
      validate(definition);

      // Runtime names must identify one tool unambiguously.
      if (runtimeNames.has(definition.runtimeName)) {
        throw new Error(
          `Duplicate tool runtime name "${definition.runtimeName}"`,
        );
      }
      runtimeNames.add(definition.runtimeName);
      const ref = toolRef(definition.id, definition.version);

      // Keep executable definitions and the grant type in lockstep.
      if (!isToolRef(ref)) {
        throw new Error(`Tool "${ref}" is not a declared tool reference`);
      }

      // Durable identities must resolve to exactly one definition.
      if (indexed.has(ref)) throw new Error(`Duplicate tool "${ref}"`);

      indexed.set(ref, Object.freeze({ ...definition }));
    }

    // Refuse grant references that have no implementation at composition.
    for (const ref of TOOL_REFS) {
      if (!indexed.has(ref)) throw new Error(`Tool "${ref}" is not registered`);
    }

    this.byRef = indexed;
  }

  resolve(ref: ToolRef): ToolDefinition {
    const definition = this.byRef.get(ref);
    if (!definition) throw new Error(`Tool "${ref}" is not registered`);
    return definition;
  }

  has(ref: ToolRef): boolean {
    return this.byRef.has(ref);
  }

  refs(): readonly ToolRef[] {
    return [...this.byRef.keys()];
  }
}

function validate(definition: ToolDefinition): void {
  const { id, version } = definition;

  if (
    typeof id !== 'string' ||
    id.trim() !== id ||
    id.length === 0 ||
    id.length > 120
  ) {
    throw new Error(`Tool id "${String(id)}" is not a valid identity`);
  }

  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`Tool "${id}" has an invalid version`);
  }

  if (
    typeof definition.description !== 'string' ||
    definition.description.trim().length === 0 ||
    definition.description.length > 500
  ) {
    throw new Error(
      `Tool "${toolRef(id, version)}" has an invalid description`,
    );
  }

  if (!RUNTIME_TOOL_NAME_PATTERN.test(definition.runtimeName ?? '')) {
    throw new Error(
      `Tool "${toolRef(id, version)}" has a runtime name an SDK would rewrite`,
    );
  }

  if (!(TOOL_RISKS as readonly string[]).includes(definition.risk)) {
    throw new Error(
      `Tool "${toolRef(id, version)}" has an invalid risk classification`,
    );
  }
}
