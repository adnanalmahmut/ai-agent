import { McpServer } from '@modelcontextprotocol/server';

import type { AgentRuntimeTool, AgentValue } from '../agent.types';
import { ToolExecutionFailure } from '../tools/tool.gateway';

/** What the server calls itself over the protocol. */
export const MCP_SERVER_NAME = 'ai-agent-platform';

/**
 * The only sentence a fault in this adapter may show a caller.
 *
 * The gateway already contains everything it raises into a
 * `ToolExecutionFailure` whose message names a tool and nothing else. This
 * exists for the residue: a defect in here, or anything a future change lets
 * escape, must not arrive at an MCP client as a driver message or a stack.
 */
export const MCP_TOOL_UNAVAILABLE = 'The tool call could not be completed';

/**
 * The MCP protocol as an adapter over tools the application already
 * authorized.
 *
 * The important property is what this function cannot do. It receives
 * `AgentRuntimeTool[]` — a name, a description, two schemas and a bound
 * closure — and has no gateway, no registry, no Prisma, no grant state, and no
 * organization or run id. So there is no authority decision available to it,
 * correctly or otherwise; it can only expose what it was handed. That is the
 * same object Mastra receives, which is what makes MCP an adapter rather than
 * a second way in.
 *
 * Called once per HTTP request with exactly that request's authorized tools,
 * because `tools/list` is derived from this instance's own registrations. The
 * effective grant set is therefore re-derived per request rather than cached,
 * and a caller sees precisely the tools their run may call.
 */
export function createGovernedMcpServer(input: {
  tools: readonly AgentRuntimeTool[];
  version: string;
}): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: input.version },
    {
      /**
       * Declared false rather than left to default true.
       *
       * The SDK advertises `listChanged` by default, which promises the client
       * a notification when the tool list changes. Serving is per-request and
       * each instance is closed after its exchange, so there is nothing alive
       * to send one — advertising it would be a capability this server cannot
       * honor.
       */
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
        /**
         * The application's own schemas, passed as full Zod objects.
         *
         * Not a restatement for the protocol's benefit: these are the same
         * `ToolDefinition` schemas the gateway parses against, so what a
         * caller is told and what is enforced cannot drift. The raw-shape
         * form the v1 SDK preferred is deprecated in v2, and full objects are
         * what this SDK converts to JSON Schema on demand.
         */
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

/**
 * One tool call, with the boundary held closed on the way out.
 *
 * A `ToolExecutionFailure` is passed through deliberately: its message is a
 * constant sentence naming only the tool's audited runtime name, and the SDK
 * turns a thrown error into an `isError` tool result carrying `error.message`.
 * So letting it propagate is what produces the right answer — the caller
 * learns the call failed and learns nothing about a row, a query, a provider,
 * or this repository's layout.
 *
 * Anything else is replaced rather than inspected. Not because the gateway is
 * expected to leak — it contains its own faults — but because this is the last
 * frame before an external client, and the cost of being wrong here is a
 * message the application never chose to publish.
 */
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

  /**
   * MCP structured content is an object, and every exposed tool's output
   * schema produces one.
   *
   * Checked rather than asserted because the two contracts are independent: a
   * future `ToolDefinition` whose output schema is a string or an array would
   * be perfectly valid to the gateway and unrepresentable here, and the SDK
   * would reject the result *after* the tool had run — which for a side effect
   * is the worst possible moment to discover it. Failing closed with the
   * constant message keeps that a refusal rather than a mystery.
   */
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new ToolExecutionFailure(MCP_TOOL_UNAVAILABLE);
  }

  return output;
}
