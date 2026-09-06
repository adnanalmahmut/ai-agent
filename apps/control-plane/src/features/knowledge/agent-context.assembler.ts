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
import { isKnowledgeSpaceSlug } from './knowledge-space.registry';

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

    const spaces = await this.spaces.resolveSlugs({
      organizationId: input.organizationId,
      slugs: policy.spaceSlugs.filter(isKnowledgeSpaceSlug),
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
