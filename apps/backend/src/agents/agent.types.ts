import type { ZodType } from 'zod';

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

export type AgentRun = {
  id: string;
  agentId: string;
  /** The definition revision this run is pinned to for its whole lifetime. */
  agentVersion: number;
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
  agentVersion: number;
  runtime: string;
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
 * The knowledge an agent is allowed to be given, and how much of it.
 *
 * Spaces are named by slug because a slug is readable in code review and in a
 * definition, where a per-deployment uuid would not be. They are resolved to
 * ids against the caller's own organization at assembly time, so naming a
 * space here grants nothing across a tenant boundary — a slug that does not
 * exist for that organization simply contributes no passages.
 *
 * Both budgets are required, and they are separate because they bound
 * different costs. `maxChunks` bounds the retrieval; `maxCharacters` bounds
 * what is actually sent, which is what the provider bills for and what
 * displaces the instructions if it grows.
 */
export type ContextPolicy = {
  spaceSlugs: readonly string[];
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
