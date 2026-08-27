import type { ZodType } from 'zod';

/**
 * Imported from the leaf registry module rather than the Knowledge barrel.
 *
 * The barrel exports services and Nest modules, and this file is the agents'
 * type vocabulary — pulling the barrel in would make every consumer of an agent
 * type depend transitively on the storage adapters. The registry is a plain
 * table with no imports of its own.
 */
import type { KnowledgeSpaceSlug } from '../knowledge/knowledge-space.registry';

export const AGENT_RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** An attempt ended badly. The only description an attempt is allowed to give. */
export const AGENT_EXECUTION_FAILED = 'Agent execution failed';

/** The transport gave up before any attempt could record an outcome. */
export const TERMINAL_TRANSPORT_FAILURE =
  'Agent execution ended without a result';

/**
 * Everything that may ever be written to `AgentRun.lastError`.
 *
 * A union of literals rather than `string`, so the compiler enforces what was
 * previously only a comment on the column. The whole containment design rests
 * on no provider message, response body, prompt or stack reaching that column,
 * and a single future caller passing `error.message` would end it silently.
 * Widening this type is the one change that makes such a call compile.
 */
export type AgentFailureDiagnostic =
  typeof AGENT_EXECUTION_FAILED | typeof TERMINAL_TRANSPORT_FAILURE;

/** JSON-compatible application data, independent of Prisma and runtime SDKs. */
export type AgentValue =
  | null
  | boolean
  | number
  | string
  | AgentValue[]
  | { [key: string]: AgentValue };

/** Definition-owned organization configuration; always a JSON object. */
export type AgentConfiguration = { [key: string]: AgentValue };

export type AgentRun = {
  id: string;
  agentId: string;
  /** The definition revision this run is pinned to for its whole lifetime. */
  agentVersion: number;
  /**
   * Immutable organization configuration selected at acceptance. Null only for
   * legacy runs created before organization-agent pinning existed.
   */
  organizationAgentVersionId: string | null;
  runtime: string;
  status: AgentRunStatus;
  organizationId: string;
  /** Null when no authenticated application User initiated the run. */
  createdByUserId: string | null;
  input: AgentValue;
  output: AgentValue | null;
  lastError: string | null;
  attemptCount: number;
  idempotencyKey: string;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * `idempotencyKey` is whole-request identity, scoped to the organization. A
 * key that has already been accepted returns the stored run as-is; the rest of
 * this payload is not compared against it. Reusing one key for a materially
 * different request therefore returns the original run rather than the one
 * asked for, so the first HTTP boundary must either bind the key to the
 * request body or reject a mismatched reuse.
 */
export type CreateAgentRun = {
  agentId: string;
  organizationId: string;
  createdByUserId: string | null;
  input: AgentValue;
  idempotencyKey: string;
  /**
   * How many runs this organization may already have in flight.
   *
   * Supplied by the caller rather than read here, because the ceiling is an
   * operator-owned runtime setting and this service is the persistence slice
   * — reading the control plane from it would put the API's acceptance path
   * behind a second resolver it does not otherwise need. Omitted means no
   * ceiling, which is what internal callers with no cost exposure want.
   */
  maxInFlight?: number;
};

export const AGENT_RUNTIME_NAMES = {
  mastra: 'mastra',
} as const;

export type AgentRuntimeName =
  (typeof AGENT_RUNTIME_NAMES)[keyof typeof AGENT_RUNTIME_NAMES];

/**
 * The code-owned configuration required to construct one runtime agent.
 *
 * A definition is immutable once identified by `(id, version)`. Changing
 * behavior means registering a new version, never editing a published one,
 * because a durable AgentRun may already be pinned to the old pair.
 */
export type AgentDefinition = {
  id: string;
  version: number;
  runtime: AgentRuntimeName;
  instructions: string;
  /**
   * `provider/model`, which is also how the provider credential is chosen.
   * The prefix names the provider; the managed secret is looked up from it.
   */
  model: string;
  /**
   * What this agent accepts and what it promises to return.
   *
   * Both are parsed, never asserted. The input schema is the trust boundary
   * for a caller's request; the output schema is the trust boundary for the
   * provider's answer, which is the less obvious of the two — a model is an
   * untrusted source that happens to be one this application pays for, and a
   * run that stored whatever came back would make `AgentRun.output` a shape
   * no consumer could rely on.
   */
  input: ZodType;
  output: ZodType;
  /**
   * The organization-owned configuration this definition understands.
   *
   * Optional means the definition is internal-only and cannot be installed.
   * When present, both the schema and default are code-owned parts of this
   * immutable definition revision. Runtime adapters never validate or own this
   * value, and callers never get an arbitrary JSON escape hatch.
   */
  organizationConfiguration?: {
    schema: ZodType<AgentConfiguration>;
    defaultValue: AgentConfiguration;
  };
  /**
   * What the parsed answer must additionally be true of, given the request.
   *
   * Separate from `output` because a Zod schema never sees the input, and the
   * claims worth making here are about the pair — most obviously that an agent
   * asked for N results returned exactly N. Absent means the schema is the
   * whole contract.
   *
   * Checked after the output schema and before any durable success is written,
   * and a violation keeps the retry budget: a model that miscounted once may
   * well count correctly on the next attempt, which is the opposite of a
   * configuration failure.
   */
  outputContract?: AgentOutputContract;
  /**
   * Which knowledge this agent may see. Absent means none at all.
   *
   * Declared on the definition rather than chosen per request, because it is
   * part of the behavior a version pins: a definition that could be pointed at
   * a different corpus by its caller would not mean anything stable, and the
   * whole point of versioning is that a run's behavior is knowable from the
   * pair it was accepted against.
   */
  contextPolicy?: ContextPolicy;
};

/**
 * Everything a contract is allowed to say about a violation.
 *
 * A closed union and two integers, not a string, for exactly the reason
 * `AgentFailureDiagnostic` above is a union of literals: the violation is
 * rendered into an `Error` message, and a `string` return would let a future
 * contract compose that message out of the provider's own answer — a plausible
 * "unexpected format \"${answer.suggestedFormat}\"" is one line, passes review as
 * a count-like message, and puts model output one `logger.warn({ err })` away
 * from Redis. Numbers cannot smuggle text, and a code has to be added here to
 * exist, which makes widening the vocabulary a reviewable act rather than an
 * invisible one.
 */
export const AGENT_OUTPUT_CONTRACT_VIOLATIONS = [
  'count_mismatch',
  'unverifiable',
] as const;

export type AgentOutputContractViolationCode =
  (typeof AGENT_OUTPUT_CONTRACT_VIOLATIONS)[number];

export type AgentOutputContractViolation =
  | {
      code: 'count_mismatch';
      /** What the request asked for. Application-owned, never provider-derived. */
      expected: number;
      /** What the answer carried. A count of the application's own parsed value. */
      received: number;
    }
  /**
   * The contract could not reach a verdict.
   *
   * A violation rather than a pass, because "I could not check" and "it is
   * fine" are different answers and only one of them is safe to store. A
   * contract that recovers its types by re-parsing has an impossible branch
   * — the runner only calls it with data its own schemas accepted — and
   * returning `null` there would make the impossible branch a silent
   * fail-open: the promise stops being enforced and nothing says so. This
   * makes it a retryable failure instead.
   */
  | { code: 'unverifiable' };

/**
 * A cross-check between what was asked for and what came back.
 *
 * The output schema is a statement about shape alone: it cannot know that a
 * request for five ideas came back with four, because the request is not in
 * scope when a schema parses a response. Some agents nonetheless promise
 * something about the *relationship* between the two, and that promise is a
 * business contract rather than a prompt hint — a caller who asked for five and
 * was billed for four received the wrong answer, however well-formed it was.
 *
 * Returns the violation, or `null` when the pair is fine.
 *
 * Both arguments arrive already parsed by the definition's own schemas, so an
 * implementation may re-parse them to recover its types and can rely on that
 * re-parse succeeding.
 */
export type AgentOutputContract = (
  input: AgentValue,
  output: AgentValue,
) => AgentOutputContractViolation | null;

/**
 * The knowledge an agent is allowed to be given, and how much of it.
 *
 * Spaces are named by slug because a slug is readable in code review and in a
 * definition, where a per-deployment uuid would not be. They are resolved to
 * ids against the caller's own organization at assembly time, so naming a
 * space here grants nothing across a tenant boundary — a slug that does not
 * exist for that organization simply contributes no passages.
 *
 * The slug type is the *registry's*, not `string`. That is the difference
 * between a policy that is wrong and a policy that does not compile: a typo, or
 * a space removed from the taxonomy, used to produce a policy that resolved to
 * nothing and reported nothing, because "no such space" and "an empty space"
 * are the same observation at retrieval time. Now it is a type error, and a
 * composition test asserts the same thing at runtime for anything that reaches
 * this shape without passing through the compiler.
 *
 * Both budgets are required, and they are separate because they bound
 * different costs. `maxChunks` bounds the retrieval; `maxCharacters` bounds
 * what is actually sent, which is what the provider bills for and what
 * displaces the instructions if it grows.
 */
export type ContextPolicy = {
  spaceSlugs: readonly KnowledgeSpaceSlug[];
  maxChunks: number;
  maxCharacters: number;
};

/** One retrieved passage, as it is handed to a runtime. */
export type AgentContextPassage = {
  /** The space it came from, by slug: provenance the model may state. */
  space: string;
  content: string;
};

export type AgentRuntimeRequest = {
  definition: AgentDefinition;
  /** Parsed application-owned configuration for the pinned organization version. */
  configuration: AgentConfiguration;
  input: AgentValue;
  /**
   * Retrieved material, kept separate from `input` all the way to the prompt.
   *
   * Never merged into the instructions. These passages are organization data
   * that some member typed, and an adapter that concatenated them into the
   * system message would be letting a document tell the agent what to do.
   */
  context: readonly AgentContextPassage[];
};

export type AgentRuntimeResult = {
  output: AgentValue;
};
