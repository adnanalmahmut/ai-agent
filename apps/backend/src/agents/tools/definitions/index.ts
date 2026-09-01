import type { ToolDefinition } from '../tool.types';
import { knowledgeSearchTool } from './knowledge-search';

/**
 * Every tool this build can execute, listed explicitly.
 *
 * The same shape as `PRODUCTION_AGENT_DEFINITIONS` and for the same reason: no
 * discovery, no directory scan, no plugin loading, no database table. What can
 * run is a property of the deployed code.
 */
export const APPLICATION_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  knowledgeSearchTool,
];

export {
  knowledgeSearchTool,
  knowledgeSearchInput,
  knowledgeSearchOutput,
  KNOWLEDGE_SEARCH_TOOL_ID,
  KNOWLEDGE_SEARCH_TOOL_VERSION,
} from './knowledge-search';
export type {
  KnowledgeSearchInput,
  KnowledgeSearchOutput,
} from './knowledge-search';
