import type { ToolDefinition } from '../../../../ai/tools/tool.types';
import { knowledgeSearchTool } from '../../../knowledge/tools/knowledge-search';
import { notificationSendTool } from './notification-send';

/**
 * Every tool this build can execute, listed explicitly.
 *
 * The same shape as `PRODUCTION_AGENT_DEFINITIONS` and for the same reason: no
 * discovery, no directory scan, no plugin loading, no database table. What can
 * run is a property of the deployed code.
 */
export const APPLICATION_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  knowledgeSearchTool,
  notificationSendTool,
];
