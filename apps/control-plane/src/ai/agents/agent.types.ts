import type { ZodType } from 'zod';

import type { AgentModelId } from '../models/model-catalog';
import type { ToolRef } from '../tools/tool-ref';

export const AGENT_RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const AGENT_EXECUTION_FAILED = 'Agent execution failed';

export const TERMINAL_TRANSPORT_FAILURE =
  'Agent execution ended without a result';

export type AgentFailureDiagnostic =
  typeof AGENT_EXECUTION_FAILED | typeof TERMINAL_TRANSPORT_FAILURE;

export type AgentValue =
  | null
  | boolean
  | number
  | string
  | AgentValue[]
  | { [key: string]: AgentValue };

export type AgentConfiguration = { [key: string]: AgentValue };

export type AgentRun = {
  id: string;
  agentId: string;
  agentVersion: number;
  organizationAgentVersionId: string | null;
  modelPolicyId: string | null;
  modelId: AgentModelId | null;
  modelPricingRevisionId: string | null;
  runtime: string;
  status: AgentRunStatus;
  organizationId: string;
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
  organizationId: string;
  createdByUserId: string | null;
  input: AgentValue;
  idempotencyKey: string;
  maxInFlight?: number;
  driver?: AgentRunDriver;
};

export const AGENT_RUN_DRIVERS = {
  worker: 'worker',
  mcpClient: 'mcp_client',
} as const;

export type AgentRunDriver =
  (typeof AGENT_RUN_DRIVERS)[keyof typeof AGENT_RUN_DRIVERS];

export const AGENT_RUNTIME_NAMES = {
  mastra: 'mastra',
} as const;

export type AgentRuntimeName =
  (typeof AGENT_RUNTIME_NAMES)[keyof typeof AGENT_RUNTIME_NAMES];

export const MCP_SESSION_RUNTIME = 'mcp';

export const MCP_SESSION_TTL_MS = 60 * 60 * 1000;

export function isMcpSessionExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() >= MCP_SESSION_TTL_MS;
}

export type AgentDefinition<TContextSpace extends string = string> = {
  id: string;
  version: number;
  runtime: AgentRuntimeName;
  instructions: string;
  model: AgentModelId;
  modelPolicy: AgentModelPolicy;
  input: ZodType;
  output: ZodType;
  organizationConfiguration?: {
    schema: ZodType<AgentConfiguration>;
    defaultValue: AgentConfiguration;
  };
  outputContract?: AgentOutputContract;
  contextPolicy?: ContextPolicy<TContextSpace>;
  maxToolGrants?: readonly ToolRef[];
};

export type AgentModelPolicy = {
  id: string;
  allowedModelIds: readonly AgentModelId[];
};

export const AGENT_OUTPUT_CONTRACT_VIOLATIONS = [
  'count_mismatch',
  'unverifiable',
] as const;

export type AgentOutputContractViolationCode =
  (typeof AGENT_OUTPUT_CONTRACT_VIOLATIONS)[number];

export type AgentOutputContractViolation =
  | {
      code: 'count_mismatch';
      expected: number;
      received: number;
    }
  | { code: 'unverifiable' };

export type AgentOutputContract = (
  input: AgentValue,
  output: AgentValue,
) => AgentOutputContractViolation | null;

export type ContextPolicy<TSpace extends string = string> = {
  spaceSlugs: readonly TSpace[];
  maxChunks: number;
  maxCharacters: number;
};

export type AgentContextPassage = {
  space: string;
  content: string;
};

export const RUNTIME_TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/;

export type AgentRuntimeTool = {
  name: string;
  description: string;
  input: ZodType;
  output: ZodType;
  execute: (input: AgentValue) => Promise<AgentValue>;
};

export type AgentRuntimeRequest = {
  definition: AgentDefinition;
  model: AgentModelId;
  configuration: AgentConfiguration;
  input: AgentValue;
  context: readonly AgentContextPassage[];
  tools: readonly AgentRuntimeTool[];
};

export type AgentRuntimeResult = {
  output: AgentValue;
};
