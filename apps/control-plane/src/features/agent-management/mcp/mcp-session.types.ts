import { z } from 'zod';

export const MCP_SESSION_TOOL_CALL_BUDGET = 48;

export const MCP_FORWARDED_HEADERS = ['accept', 'content-type'] as const;

export const MCP_HEADER_PREFIX = 'mcp-';

export const MCP_REFUSED_METHODS = ['subscriptions/listen'] as const;

export const MCP_EXCHANGE_DEADLINE_MS = 30_000;

export const openMcpSessionInput = z
  .object({
    agentId: z.string().trim().min(1).max(120),
  })
  .strict();

export type OpenMcpSessionInput = z.infer<typeof openMcpSessionInput>;

export type McpSessionAccepted = {
  runId: string;
  agentId: string;
  expiresAt: string;
};

export type McpSessionClosed = {
  runId: string;
  closedBy: 'client' | 'expiry' | 'already_closed';
};

export type McpExchange = {
  status: number;
  headers: Record<string, string>;
  body: string;
};
