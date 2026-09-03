import type { ToolDefinition } from '../../../../ai/tools/tool.types';
import { knowledgeSearchTool } from '../../../knowledge/tools/knowledge-search';
import { notificationSendTool } from './notification-send';

export const APPLICATION_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  knowledgeSearchTool,
  notificationSendTool,
];
