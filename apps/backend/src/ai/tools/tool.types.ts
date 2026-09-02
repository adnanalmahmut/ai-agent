import type { ZodType } from 'zod';

import type { ExternalEffectOutcome } from '../../core/external-effect';
import type { AgentDefinition, AgentValue } from '../agents/agent.types';
import type { ToolRef } from './tool-ref';

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
export { TOOL_REFS, isToolRef, toolRef } from './tool-ref';
export type { ToolRef } from './tool-ref';

/**
 * What a tool may do, decided in code and never by a caller.
 *
 * `read_only` runs inline during a generation and its result goes back to the
 * model. `side_effect` never runs inline: the model may only *propose* it, the
 * proposal is recorded as `AWAITING_APPROVAL`, and the effect is performed
 * later by the worker after a human decision and a fresh revalidation. The
 * classification is what selects which of the two lifecycles a call gets, so
 * it is a property of the code-owned definition and never of the caller.
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

/** The application-side behavior of one registered `read_only` tool. */
export interface ToolImplementation {
  readonly ref: ToolRef;
  execute(input: AgentValue, context: ToolInvocationContext): Promise<unknown>;
}

/**
 * Why an approved side effect may not be performed after all.
 *
 * Closed, and deliberately coarse: each code names the precondition that no
 * longer holds, not what was found. `precondition_recipient` says the member
 * is gone or undeliverable, never which. These are written to `failureCode`
 * and read by an operator, so the same argument that keeps provider text out
 * of that column keeps the detail out of these.
 *
 * `delivery_unsupported` is a precondition of the deployment rather than of
 * the data: the configured mail driver offers no idempotency guarantee, so the
 * retry contract cannot be honoured and the effect fails closed before any
 * send rather than sending once and hoping.
 */
export const SIDE_EFFECT_PRECONDITION_CODES = [
  'precondition_organization',
  'precondition_authority',
  'precondition_approval',
  'precondition_recipient',
  'delivery_unsupported',
] as const;

export type SideEffectPreconditionCode =
  (typeof SIDE_EFFECT_PRECONDITION_CODES)[number];

/**
 * A precondition that no longer holds, as the only thing an implementation may
 * throw to say so.
 *
 * Carries a closed code and nothing else — no message composed from the
 * recipient, the member, or the row that was read. The worker maps the code
 * straight to `failureCode`; anything else an implementation throws is
 * treated as a transient fault and retried without being read.
 */
export class SideEffectPreconditionError extends Error {
  constructor(readonly code: SideEffectPreconditionCode) {
    super(`Side-effect precondition failed: ${code}`);
    this.name = 'SideEffectPreconditionError';
  }
}

export function isSideEffectPreconditionError(
  value: unknown,
): value is SideEffectPreconditionError {
  return value instanceof SideEffectPreconditionError;
}

/**
 * An effect that has been revalidated and is ready to perform, but has not
 * been performed.
 *
 * `payloadDigest` is the digest of exactly what `deliver` will send. The
 * worker stores it on the first attempt and refuses a later attempt whose
 * digest differs: the provider deduplicates on the key *and* the payload, so a
 * changed payload under the same key is either refused by the provider or —
 * if the first attempt never arrived — a different message than the one
 * approved. Neither is acceptable, and the digest is how that is known without
 * persisting the recipient's address.
 *
 * `deliver` takes the idempotency key rather than computing one, because the
 * key is derived from durable execution identity the implementation does not
 * own. Retrying with the same key and the same payload is the whole contract.
 */
export type PreparedEffect = {
  payloadDigest: string;
  deliver: (idempotencyKey: string) => Promise<ExternalEffectOutcome>;
};

/**
 * The application-side behavior of one registered `side_effect` tool.
 *
 * Two phases, called at different times by different processes. `propose`
 * runs inside the generation when the model calls the tool: it checks what
 * can be checked then — the recipient is a member of this organization — and
 * throws a `SideEffectPreconditionError` to refuse, so nothing durable is
 * written for a proposal that could never be performed. `prepareEffect` runs
 * in the worker after approval and immediately before the effect: it resolves
 * the mutable state again from scratch, refuses again if anything changed, and
 * returns the effect ready to perform.
 *
 * There is deliberately no `execute`. A side effect that could be performed
 * from inside the generation would be a side effect the model performs.
 */
export interface SideEffectToolImplementation {
  readonly ref: ToolRef;
  readonly kind: 'side_effect';
  propose(input: AgentValue, context: ToolInvocationContext): Promise<void>;
  prepareEffect(
    input: AgentValue,
    context: ToolInvocationContext,
  ): Promise<PreparedEffect>;
}

export type AnyToolImplementation =
  ToolImplementation | SideEffectToolImplementation;

export function isSideEffectImplementation(
  implementation: AnyToolImplementation,
): implementation is SideEffectToolImplementation {
  return (
    'kind' in implementation &&
    (implementation as { kind?: unknown }).kind === 'side_effect'
  );
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
  /** A side-effect precondition no longer held when the effect was due. */
  ...SIDE_EFFECT_PRECONDITION_CODES,
  /**
   * The provider refused the request deterministically — a 4xx it would
   * refuse again with the same payload. Nothing was sent. The provider's own
   * code and prose stay on the provider's side of the boundary.
   */
  'provider_rejected',
] as const;

export type ToolFailureCode = (typeof TOOL_FAILURE_CODES)[number];
