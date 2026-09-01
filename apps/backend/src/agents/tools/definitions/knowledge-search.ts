import { z } from 'zod';

import type { ToolDefinition } from '../tool.types';

export const KNOWLEDGE_SEARCH_TOOL_ID = 'knowledge.search';
export const KNOWLEDGE_SEARCH_TOOL_VERSION = 1;

/**
 * The only thing the model may supply.
 *
 * Deliberately not an organization id, a space list, an embedding model, or a
 * limit. Every one of those is either a tenant boundary or a cost decision, and
 * a caller that could name one would be choosing whose material it reads or how
 * much of it this application pays to retrieve. The scope comes from the pinned
 * definition's `contextPolicy`; the ceiling comes from the operator.
 *
 * Bounded because it is embedded, and an embedding call is billed by length.
 */
export const knowledgeSearchInput = z
  .object({
    query: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * Ranked whole passages with their space provenance.
 *
 * The same shape `AgentContextPassage` already has, because this tool is the
 * pull-based form of the push-based context the assembler already builds — one
 * retrieval path, not two. `space` is a slug the model may cite; it names a
 * space within the caller's own organization and identifies nothing outside it.
 */
export const knowledgeSearchOutput = z
  .object({
    passages: z
      .array(
        z
          .object({
            space: z.string(),
            content: z.string(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchInput>;
export type KnowledgeSearchOutput = z.infer<typeof knowledgeSearchOutput>;

export const knowledgeSearchTool: ToolDefinition = {
  id: KNOWLEDGE_SEARCH_TOOL_ID,
  version: KNOWLEDGE_SEARCH_TOOL_VERSION,
  runtimeName: 'knowledge_search_v1',
  description:
    'Search the organization knowledge this agent is permitted to read, and return ranked passages with the space each came from.',
  input: knowledgeSearchInput,
  output: knowledgeSearchOutput,
  risk: 'read_only',
};
