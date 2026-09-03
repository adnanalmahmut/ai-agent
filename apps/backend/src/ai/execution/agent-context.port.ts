import type { AgentContextPassage, ContextPolicy } from '../agents/agent.types';

export const AGENT_CONTEXT = Symbol('AGENT_CONTEXT');

/**
 * Generic execution boundary for assembling context for an accepted run.
 *
 * The AI runner owns when context is requested, while the product knowledge
 * feature owns how tenant-scoped knowledge is resolved and retrieved.
 */
export interface AgentContextPort {
  assemble(input: {
    organizationId: string;
    policy: ContextPolicy | undefined;
    query: string;
  }): Promise<AgentContextPassage[]>;
}
