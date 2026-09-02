import type {
  AgentRuntimeName,
  AgentRuntimeRequest,
  AgentRuntimeResult,
} from '../agents/agent.types';

/** Replaceable execution boundary owned by the application, not an SDK. */
export interface AgentRuntime {
  readonly name: AgentRuntimeName;
  run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult>;
}
