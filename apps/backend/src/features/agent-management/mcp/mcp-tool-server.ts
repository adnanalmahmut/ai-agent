import { McpServer } from '@modelcontextprotocol/server';

import type {
  AgentRuntimeTool,
  AgentValue,
} from '../../../ai/agents/agent.types';
import { ToolExecutionFailure } from '../../../ai/tools/tool.gateway';

export const MCP_SERVER_NAME = 'ai-agent-platform';

export const MCP_TOOL_UNAVAILABLE = 'The tool call could not be completed';

export function createGovernedMcpServer(input: {
  tools: readonly AgentRuntimeTool[];
  version: string;
}): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: input.version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        'Tools are granted per organization and per agent. A tool that ' +
        'performs an external action can only be proposed here; a person in ' +
        'the organization decides whether it happens.',
    },
  );

  for (const tool of input.tools) {
    server.registerTool(
      // The audited `runtimeName` the definition owns, which is also the name
      // the durable `ToolExecution` row's `toolId`/`toolVersion` pair maps to.
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
      },
      async (args) => {
        const output = await execute(tool, args as AgentValue);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        };
      },
    );
  }

  return server;
}

async function execute(
  tool: AgentRuntimeTool,
  input: AgentValue,
): Promise<{ [key: string]: AgentValue }> {
  let output: AgentValue;

  try {
    output = await tool.execute(input);
  } catch (error) {
    if (error instanceof ToolExecutionFailure) throw error;
    throw new ToolExecutionFailure(MCP_TOOL_UNAVAILABLE);
  }

  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new ToolExecutionFailure(MCP_TOOL_UNAVAILABLE);
  }

  return output;
}
