import { Inject, Injectable } from '@nestjs/common';

import { RUNTIME_TOOL_NAME_PATTERN } from '../agent.types';
import {
  TOOL_REFS,
  TOOL_RISKS,
  isToolRef,
  toolRef,
  type ToolDefinition,
  type ToolRef,
} from './tool.types';

export const TOOL_DEFINITIONS = Symbol('TOOL_DEFINITIONS');

/**
 * Explicit code-owned tools. There is no discovery, no plugin loading, no
 * database table, and no runtime registration path.
 *
 * Composition is the only place a tool can enter the system, so every rule
 * about identity is enforced here and enforced loudly: a build whose tool
 * vocabulary is wrong must fail to start rather than run with a grant that
 * resolves to nothing.
 */
@Injectable()
export class ToolRegistry {
  private readonly byRef: ReadonlyMap<ToolRef, ToolDefinition>;

  constructor(@Inject(TOOL_DEFINITIONS) definitions: readonly ToolDefinition[]) {
    const indexed = new Map<ToolRef, ToolDefinition>();
    const runtimeNames = new Set<string>();

    for (const definition of definitions) {
      validate(definition);

      // Two tools offered to a model under one name is not a naming problem,
      // it is an ambiguity about which one the model called.
      if (runtimeNames.has(definition.runtimeName)) {
        throw new Error(
          `Duplicate tool runtime name "${definition.runtimeName}"`,
        );
      }
      runtimeNames.add(definition.runtimeName);
      const ref = toolRef(definition.id, definition.version);

      // A tool that is registered but not in `TOOL_REFS` cannot be granted by
      // anything — the grant type would not accept it — so it is dead code
      // that looks live. Refusing it here keeps the union honest.
      if (!isToolRef(ref)) {
        throw new Error(`Tool "${ref}" is not a declared tool reference`);
      }

      // Two definitions claiming one `(id, version)` make the pair meaningless
      // as durable identity: a stored grant and a stored `ToolExecution` would
      // both resolve to whichever was registered last.
      if (indexed.has(ref)) throw new Error(`Duplicate tool "${ref}"`);

      indexed.set(ref, Object.freeze({ ...definition }));
    }

    // The other direction. A declared reference with no definition is a grant
    // that type-checks everywhere and fails at execution time on some later
    // run, which is the worst moment to discover it.
    for (const ref of TOOL_REFS) {
      if (!indexed.has(ref)) throw new Error(`Tool "${ref}" is not registered`);
    }

    this.byRef = indexed;
  }

  /** Resolves the exact pinned identity. There is deliberately no latest-version fallback. */
  resolve(ref: ToolRef): ToolDefinition {
    const definition = this.byRef.get(ref);
    if (!definition) throw new Error(`Tool "${ref}" is not registered`);
    return definition;
  }

  has(ref: ToolRef): boolean {
    return this.byRef.has(ref);
  }

  /** Every registered identity, for composition checks that must be total. */
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

  // A version is what a grant and a durable execution record pin. Zero, a
  // fraction, or a negative would all still format into a plausible-looking
  // `id@version` string and then never match anything.
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`Tool "${id}" has an invalid version`);
  }

  if (
    typeof definition.description !== 'string' ||
    definition.description.trim().length === 0 ||
    definition.description.length > 500
  ) {
    throw new Error(`Tool "${toolRef(id, version)}" has an invalid description`);
  }

  /**
   * Checked here so an unusable name cannot reach an adapter.
   *
   * Mastra would not reject it — it would rewrite it, which is worse: the
   * offered name would silently stop matching the reviewed one.
   */
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
