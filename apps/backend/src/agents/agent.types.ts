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
  | typeof AGENT_EXECUTION_FAILED
  | typeof TERMINAL_TRANSPORT_FAILURE;

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
  model: string;
};

export type AgentRuntimeRequest = {
  definition: AgentDefinition;
  input: AgentValue;
};

export type AgentRuntimeResult = {
  output: AgentValue;
};
