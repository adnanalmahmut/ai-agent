import { describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type {
  AgentRuntimeTool,
  AgentValue,
} from '../../../../ai/agents/agent.types';
import { ToolExecutionFailure } from '../../../../ai/tools/tool.gateway';
import {
  createGovernedMcpServer,
  MCP_TOOL_UNAVAILABLE,
} from '../mcp-tool-server';

/**
 * The protocol seam, driven by the real client SDK.
 *
 * `InMemoryTransport` speaks to an `McpServer` directly, so what this file
 * asserts is the adapter's own contract: which tools a caller is offered, what
 * schemas they carry, and exactly what a caller learns when a call fails. It
 * deliberately does not exercise HTTP, authorization, or the session — those
 * are authority claims and belong to the e2e suite, where a real request and a
 * real database can refuse.
 *
 * Written against measured v2 behavior rather than v1 habits, because the two
 * disagree on the point that matters most here: an unknown tool name is a
 * JSON-RPC error, while a schema-invalid argument comes back as a *successful*
 * response carrying `isError`.
 */

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

/** A connected client speaking to a server built over exactly these tools. */
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

    /**
     * The empty case, which is the normal one for an agent granted nothing.
     *
     * Asserted because the failure it guards is silent in the wrong direction:
     * an adapter that fell back to "all registered tools" when handed none
     * would look correct in every test that grants something.
     */
    it('offers nothing when the run was granted nothing', async () => {
      const { client, close } = await connect([]);

      await expect(client.listTools()).resolves.toEqual(
        expect.objectContaining({ tools: [] }),
      );

      await close();
    });

    /**
     * The schemas are the application's, converted rather than restated.
     *
     * This is what stops a caller being told one contract while the gateway
     * enforces another: there is only one schema object, and it is the
     * `ToolDefinition`'s.
     */
    it('publishes the application’s own input schema', async () => {
      const { client, close } = await connect([tool()]);

      const [listed] = (await client.listTools()).tools;

      expect(listed.inputSchema).toMatchObject({
        type: 'object',
        properties: { query: expect.objectContaining({ type: 'string' }) },
        required: ['query'],
      });
      // `.strict()` on the application schema must survive the conversion, or
      // a caller could be told extra properties are acceptable.
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

      /**
       * One argument, and it is the tool's own input.
       *
       * The closure is already bound to its run and organization, so there is
       * nothing for a caller to influence beyond this — but a second argument
       * appearing here would mean the adapter had started passing context the
       * runtime boundary deliberately withholds.
       */
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]).toEqual([{ query: 'brand voice' }]);

      await close();
    });

    /**
     * A name the caller was not given fails closed, as a protocol error.
     *
     * Measured, not assumed: the SDK throws this one *before* its own handler
     * catch, so it reaches the client as JSON-RPC `-32602` rather than as an
     * `isError` result. A caller cannot reach an unregistered tool even by
     * naming it exactly.
     */
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
      // The refusal happens before the closure, so nothing durable was written
      // and no paid work was done.
      expect(execute).not.toHaveBeenCalled();

      await close();
    });
  });

  /**
   * What a caller learns when something goes wrong, which is the containment
   * boundary this adapter is responsible for.
   */
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

    /**
     * Anything that is not already contained is replaced, not inspected.
     *
     * The driver message here is the realistic shape of the leak: a Prisma
     * rejection names the connection target and renders the arguments it was
     * called with, which at this point are the tool's input. None of it may
     * reach an external client.
     */
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

    /**
     * A stack would render this repository's paths and layout to a caller.
     *
     * `ToolExecutionFailure` deletes its own, and this proves the adapter does
     * not reintroduce one by wrapping or re-serializing the error.
     */
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

    /**
     * An output shape the protocol cannot represent fails closed.
     *
     * A `ToolDefinition` whose output schema is not an object is valid to the
     * gateway and unrepresentable as MCP structured content. Refusing with the
     * constant message keeps that a refusal rather than an SDK validation
     * error raised after the tool has already run — which, for a side effect,
     * would be the worst moment to notice.
     */
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

  /**
   * The capability the server declines to advertise.
   *
   * Serving is per-request and each instance is closed with its exchange, so
   * there is nothing alive to send a `tools/list_changed` notification. The
   * SDK advertises it by default, and advertising a promise this server cannot
   * keep is the kind of thing a conforming client is entitled to rely on.
   */
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
