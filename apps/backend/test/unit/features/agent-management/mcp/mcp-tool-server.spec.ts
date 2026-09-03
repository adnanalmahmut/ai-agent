import { describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type {
  AgentRuntimeTool,
  AgentValue,
} from '../../../../../src/ai/agents/agent.types';
import { ToolExecutionFailure } from '../../../../../src/ai/tools/tool.gateway';
import {
  createGovernedMcpServer,
  MCP_TOOL_UNAVAILABLE,
} from '../../../../../src/features/agent-management/mcp/mcp-tool-server';

const searchInput = z.object({ query: z.string().min(1).max(200) }).strict();

const searchOutput = z
  .object({ passages: z.array(z.object({ content: z.string() })) })
  .strict();

const tool = (overrides: Partial<AgentRuntimeTool> = {}): AgentRuntimeTool => ({
  name: 'knowledge_search_v1',
  description: 'Search the organization’s reference material.',
  input: searchInput,
  output: searchOutput,
  execute: () => Promise.resolve({ passages: [{ content: 'Be concise.' }] }),
  ...overrides,
});

const connect = async (tools: readonly AgentRuntimeTool[]) => {
  const server = createGovernedMcpServer({ tools, version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, close: () => client.close() };
};

describe('the MCP adapter over authorized tools', () => {
  describe('tools/list', () => {
    it('offers exactly the tools it was handed, and no others', async () => {
      const { client, close } = await connect([
        tool(),
        tool({ name: 'notification_send_v1' }),
      ]);

      const listed = await client.listTools();

      expect(listed.tools.map((entry) => entry.name).sort()).toEqual([
        'knowledge_search_v1',
        'notification_send_v1',
      ]);

      await close();
    });

    it('offers nothing when the run was granted nothing', async () => {
      const { client, close } = await connect([]);

      await expect(client.listTools()).resolves.toEqual(
        expect.objectContaining({ tools: [] }),
      );

      await close();
    });

    it('publishes the application’s own input schema', async () => {
      const { client, close } = await connect([tool()]);

      const [listed] = (await client.listTools()).tools;

      expect(listed.inputSchema).toMatchObject({
        type: 'object',
        properties: { query: expect.objectContaining({ type: 'string' }) },
        required: ['query'],
      });
      expect(listed.inputSchema).toMatchObject({
        additionalProperties: false,
      });

      await close();
    });
  });

  describe('tools/call', () => {
    it('returns the tool’s parsed result as structured content', async () => {
      const { client, close } = await connect([tool()]);

      const result = await client.callTool({
        name: 'knowledge_search_v1',
        arguments: { query: 'brand voice' },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        passages: [{ content: 'Be concise.' }],
      });

      await close();
    });

    it('passes the caller’s arguments to the bound closure and nothing else', async () => {
      const execute = jest.fn<(input: AgentValue) => Promise<AgentValue>>(() =>
        Promise.resolve({ passages: [] }),
      );
      const { client, close } = await connect([tool({ execute })]);

      await client.callTool({
        name: 'knowledge_search_v1',
        arguments: { query: 'brand voice' },
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]).toEqual([{ query: 'brand voice' }]);

      await close();
    });

    it('refuses a tool it was not handed', async () => {
      const { client, close } = await connect([tool()]);

      await expect(
        client.callTool({ name: 'notification_send_v1', arguments: {} }),
      ).rejects.toMatchObject({ code: -32602 });

      await close();
    });

    it('refuses arguments the application’s schema rejects', async () => {
      const execute = jest.fn<(input: AgentValue) => Promise<AgentValue>>(() =>
        Promise.resolve({ passages: [] }),
      );
      const { client, close } = await connect([tool({ execute })]);

      const result = await client.callTool({
        name: 'knowledge_search_v1',
        arguments: { query: '', extra: 'not allowed' },
      });

      expect(result.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();

      await close();
    });
  });

  describe('containment', () => {
    it('shows the gateway’s constant sentence and nothing more', async () => {
      const { client, close } = await connect([
        tool({
          execute: () =>
            Promise.reject(
              new ToolExecutionFailure(
                'Tool "knowledge_search_v1" could not be completed',
              ),
            ),
        }),
      ]);

      const result = await client.callTool({
        name: 'knowledge_search_v1',
        arguments: { query: 'brand voice' },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: 'text',
          text: 'Tool "knowledge_search_v1" could not be completed',
        },
      ]);

      await close();
    });

    it('replaces an uncontained failure rather than forwarding it', async () => {
      const { client, close } = await connect([
        tool({
          execute: () =>
            Promise.reject(
              new Error(
                'Invalid `prisma.toolExecution.create()` invocation: connect ECONNREFUSED 10.0.0.5:5432',
              ),
            ),
        }),
      ]);

      const result = await client.callTool({
        name: 'knowledge_search_v1',
        arguments: { query: 'brand voice' },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: MCP_TOOL_UNAVAILABLE },
      ]);

      const rendered = JSON.stringify(result);
      for (const secret of ['prisma', 'ECONNREFUSED', '10.0.0.5', '5432']) {
        expect(rendered).not.toContain(secret);
      }

      await close();
    });

    it('never renders a stack or a file path to the caller', async () => {
      const { client, close } = await connect([
        tool({ execute: () => Promise.reject(new Error('boom')) }),
      ]);

      const result = await client.callTool({
        name: 'knowledge_search_v1',
        arguments: { query: 'brand voice' },
      });

      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain('.ts');
      expect(rendered).not.toContain('/src/');
      expect(rendered).not.toContain('at ');

      await close();
    });

    it('refuses a non-object tool result', async () => {
      const { client, close } = await connect([
        tool({
          output: z.string(),
          execute: () => Promise.resolve('not an object'),
        }),
      ]);

      const result = await client.callTool({
        name: 'knowledge_search_v1',
        arguments: { query: 'brand voice' },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: MCP_TOOL_UNAVAILABLE },
      ]);

      await close();
    });
  });

  it('does not advertise a tool-list-changed capability it cannot honor', () => {
    const server = createGovernedMcpServer({
      tools: [tool()],
      version: '1.0.0',
    });

    expect(server.server.getCapabilities()).toMatchObject({
      tools: { listChanged: false },
    });
  });
});
