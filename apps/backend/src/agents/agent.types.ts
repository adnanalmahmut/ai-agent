export const AGENT_RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

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

/** The code-owned configuration required to construct one runtime agent. */
export type AgentDefinition = {
  id: string;
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
