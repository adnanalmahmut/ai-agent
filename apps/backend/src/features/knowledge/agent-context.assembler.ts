import { Inject, Injectable } from '@nestjs/common';

import {
  EMBEDDING_PORT,
  KnowledgeRetrievalService,
  KnowledgeSpaceService,
  type EmbeddingPort,
} from './';
import type { AgentContextPort } from '../../ai/execution/agent-context.port';
import type {
  AgentContextPassage,
  ContextPolicy,
} from '../../ai/agents/agent.types';

/**
 * Choosing what an agent is allowed to see, in the application.
 *
 * This is deliberately not a runtime concern. Mastra has its own retrieval
 * primitives, and using them would put the tenant predicate, the space policy
 * and the context budget inside a framework — three decisions that are the
 * whole security story of a multi-tenant agent, expressed in something this
 * repository does not own and cannot test the SQL of.
 *
 * Nothing here trusts the definition to be right about the organization. The
 * policy names spaces by slug and the slugs are resolved against the caller's
 * own organization, so a policy naming a slug that belongs to someone else
 * resolves to nothing rather than to their material.
 */
@Injectable()
export class AgentContextAssembler implements AgentContextPort {
  constructor(
    private readonly spaces: KnowledgeSpaceService,
    private readonly retrieval: KnowledgeRetrievalService,
    @Inject(EMBEDDING_PORT) private readonly embeddings: EmbeddingPort,
  ) {}

  async assemble(input: {
    organizationId: string;
    policy: ContextPolicy | undefined;
    query: string;
  }): Promise<AgentContextPassage[]> {
    const policy = input.policy;

    // No policy is no context. An agent that did not declare what it may read
    // does not get "everything" as a default.
    if (policy === undefined || policy.spaceSlugs.length === 0) return [];

    const trimmed = input.query.trim();

    // Nothing to be similar to. Embedding an empty string returns a direction
    // that is arbitrary rather than absent, and it would still cost a call.
    if (trimmed.length === 0) return [];

    /**
     * Through the Knowledge domain's own service, not `prisma` directly. The
     * knowledge barrel deliberately withholds storage access, and this is the
     * one query outside that module that would otherwise have to name a table
     * — which is also where a tenant predicate would go missing unnoticed.
     */
    const spaces = await this.spaces.resolveSlugs({
      organizationId: input.organizationId,
      slugs: policy.spaceSlugs,
    });

    if (spaces.length === 0) return [];

    const [embedding] = await this.embeddings.embed([trimmed]);

    if (embedding === undefined) return [];

    const matches = await this.retrieval.search({
      organizationId: input.organizationId,
      spaceIds: spaces.map((space) => space.id),
      embedding,
      embeddingModel: this.embeddings.model,
      limit: policy.maxChunks,
    });

    const slugOf = new Map(spaces.map((space) => [space.id, space.slug]));

    return withinBudget(
      matches.map((match) => ({
        space: slugOf.get(match.spaceId) ?? 'unknown',
        content: match.content,
      })),
      policy.maxCharacters,
    );
  }
}

/**
 * Takes passages in ranked order until the character budget is spent.
 *
 * Whole passages, never a truncated one. Half a paragraph reads as a complete
 * thought that happens to end early, which is worse than its absence: the
 * model cannot tell that something was cut, and neither can a reader checking
 * why the answer said what it did.
 *
 * A passage over budget on its own is skipped rather than ending the loop —
 * one long document should not hide every shorter passage ranked behind it.
 */
function withinBudget(
  passages: readonly AgentContextPassage[],
  maxCharacters: number,
): AgentContextPassage[] {
  const kept: AgentContextPassage[] = [];
  let spent = 0;

  for (const passage of passages) {
    const cost = passage.content.length;

    if (spent + cost > maxCharacters) continue;

    kept.push(passage);
    spent += cost;
  }

  return kept;
}
