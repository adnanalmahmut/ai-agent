import type {
  AgentRuntimeName,
  AgentRuntimeRequest,
  AgentRuntimeResult,
} from '../agents/agent.types';

export interface AgentRuntime {
  readonly name: AgentRuntimeName;
  run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult>;
}
