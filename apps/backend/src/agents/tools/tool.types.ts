import type { ZodType } from 'zod';

import type { AgentDefinition, AgentValue } from '../agent.types';

/**
 * Every tool this build can execute, named exactly once.
 *
 * A literal union rather than `string`, for the same reason `KnowledgeSpaceSlug`
 * is one: a typo in a definition's grant list should be a compile error, not a
 * grant that resolves to nothing and reports nothing. The registry asserts at
 * composition that this list and the registered definitions describe the same
 * set, so neither half can drift ahead of the other.
 *
 * The encoded `id@version` form is also what is persisted in
 * `OrganizationAgentVersion.toolGrants`, so a stored grant is readable in a
 * database row without a join.
 */
export const TOOL_REFS = ['knowledge.search@1'] as const;

export type ToolRef = (typeof TOOL_REFS)[number];

export function isToolRef(value: unknown): value is ToolRef {
  return (
    typeof value === 'string' &&
    (TOOL_REFS as readonly string[]).includes(value)
  );
}

/** Composes the durable identity. The only place the `@` form is built. */
export function toolRef(id: string, version: number): string {
  return `${id}@${version}`;
}

/**
 * What a tool may do, decided in code and never by a caller.
 *
 * TOOL-01 executes `read_only` only. `side_effect` exists in the vocabulary
 * because the registry has to be able to *refuse* one — a classification that
 * appeared for the first time alongside the machinery to run it would give the
 * refusal nothing to stand on.
 */
export const TOOL_RISKS = ['read_only', 'side_effect'] as const;

export type ToolRisk = (typeof TOOL_RISKS)[number];

/**
 * One code-owned tool.
 *
 * Immutable once identified by `(id, version)`, exactly like an
 * `AgentDefinition`: an organization grant and a durable `ToolExecution` both
 * name the pair, so changing what a version does means registering a new one.
 *
 * Schemas are the application's, not the SDK's. Mastra is handed copies so it
 * can ask the provider for the right shape, but the gateway parses both sides
 * again — the provider is an untrusted caller that this application happens to
 * pay for.
 */
export type ToolDefinition = {
  id: string;
  version: number;
  /**
   * The name the model actually sees, declared rather than derived.
   *
   * The durable identity `knowledge.search@1` cannot be used here. Mastra keys
   * its tool record by the model-facing name and *silently rewrites* any key
   * that is not `^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$` — `Agent.formatTools` replaces
   * every offending character with `_`, truncates to 63, and deletes the
   * original key. Both `.` and `@` are offending characters, so the durable
   * identity would arrive at the provider as something this repository never
   * wrote and never reviewed, and two identities normalising to one name throw
   * a collision error from inside the SDK.
   *
   * So the name is spelled out and validated at composition instead. What the
   * model is offered is then a fact of this file rather than an artifact of an
   * SDK's sanitiser, and it stays stable if that sanitiser changes.
   *
   * It is a label, never authority: `ToolExecution` records `toolId` and
   * `toolVersion`, so history says what actually ran even if a future adapter
   * presents it under a different name.
   */
  runtimeName: string;
  /** Shown to the model. Bounded, and free of anything tenant-specific. */
  description: string;
  input: ZodType;
  output: ZodType;
  risk: ToolRisk;
};

/**
 * What an implementation is allowed to know about who is calling it.
 *
 * Assembled by the application from the accepted run, never by the runtime and
 * never from tool arguments. The pinned definition travels with it because a
 * tool's permitted scope can be a property of the agent — `knowledge.search@1`
 * reads the definition's `contextPolicy` as its maximum visibility rather than
 * accepting a scope from its caller.
 */
export type ToolInvocationContext = {
  organizationId: string;
  agentRunId: string;
  agentRunAttempt: number;
  definition: AgentDefinition;
};

/** The application-side behavior of one registered tool. */
export interface ToolImplementation {
  readonly ref: ToolRef;
  execute(input: AgentValue, context: ToolInvocationContext): Promise<unknown>;
}

/**
 * Everything a failed `ToolExecution` is allowed to say.
 *
 * A closed union for the same reason `AgentFailureDiagnostic` is one: this
 * value is written to a durable column and read by an operator, and a `string`
 * would let one future caller pass `error.message` and put a provider response
 * body in the database without anybody noticing. Adding a code has to be an
 * edit here, which makes widening the vocabulary reviewable.
 */
export const TOOL_FAILURE_CODES = [
  /** The implementation threw. Nothing of what it threw is kept. */
  'implementation_error',
  /** The implementation returned something its own output schema refuses. */
  'output_rejected',
] as const;

export type ToolFailureCode = (typeof TOOL_FAILURE_CODES)[number];
