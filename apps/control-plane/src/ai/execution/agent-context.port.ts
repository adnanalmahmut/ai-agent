import type { AgentContextPassage, ContextPolicy } from '../agents/agent.types';

export const AGENT_CONTEXT = Symbol('AGENT_CONTEXT');

export interface AgentContextPort {
  assemble(input: {
    organizationId: string;
    policy: ContextPolicy | undefined;
    query: string;
  }): Promise<AgentContextPassage[]>;
}
