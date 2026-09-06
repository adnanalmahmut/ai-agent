import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { inspect } from 'node:util';
import { z } from 'zod';

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';

import {
  containMastraAgent,
  MastraRuntime,
  toMastraTools,
} from '../../../../../../src/ai/infrastructure/runtimes/mastra/mastra.runtime';

import {
  AGENT_RUNTIME_NAMES,
  type AgentDefinition,
  type AgentRuntimeTool,
} from '../../../../../../src/ai/agents/agent.types';
import { MODEL_IDS } from '../../../../../../src/ai/models/model-catalog';
import {
  ToolExecutionFailure,
  ToolGateway,
} from '../../../../../../src/ai/tools/tool.gateway';
import { ToolRegistry } from '../../../../../../src/ai/tools/tool.registry';
import type { ToolRef } from '../../../../../../src/ai/tools/tool.types';

const SYSTEM_INSTRUCTIONS_CANARY = 'CANARY_SYSTEM_INSTRUCTIONS_a1b2c3';
const USER_PROMPT_CANARY = 'CANARY_USER_PROMPT_d4e5f6';
const PROVIDER_RESPONSE_CANARY = 'CANARY_PROVIDER_RESPONSE_BODY_9z8y7x';
const CREDENTIAL_CANARY = 'CANARY_PROVIDER_CREDENTIAL_sk-not-real-5t6u7v';

const ALL_CANARIES = [
  SYSTEM_INSTRUCTIONS_CANARY,
  USER_PROMPT_CANARY,
  PROVIDER_RESPONSE_CANARY,
] as const;

const CONSOLE_METHODS = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'dir',
] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];
type ConsoleSpy = jest.Spied<(...args: unknown[]) => void>;
type ConsoleSpies = Record<ConsoleMethod, ConsoleSpy>;

function captureConsole(): ConsoleSpies {
  const sinks = console as unknown as Record<
    ConsoleMethod,
    (...args: unknown[]) => void
  >;

  const entries = CONSOLE_METHODS.map((method) => [
    method,
    jest.spyOn(sinks, method).mockImplementation(() => undefined),
  ]);

  return Object.fromEntries(entries) as ConsoleSpies;
}

function totalConsoleCalls(spies: ConsoleSpies): number {
  return CONSOLE_METHODS.reduce(
    (count, method) => count + spies[method].mock.calls.length,
    0,
  );
}

function consoleCallCounts(spies: ConsoleSpies): Record<ConsoleMethod, number> {
  return Object.fromEntries(
    CONSOLE_METHODS.map((method) => [method, spies[method].mock.calls.length]),
  ) as Record<ConsoleMethod, number>;
}

function serializeConsole(spies: ConsoleSpies): string {
  return inspect(
    CONSOLE_METHODS.map((method) => [method, spies[method].mock.calls]),
    { depth: null, maxStringLength: null, maxArrayLength: null },
  );
}

function forbidNetwork(): jest.Spied<typeof fetch> {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access attempted in a hermetic containment test');
  });
}

function createLeakyStubModel() {
  const fail = (options: { prompt?: unknown }): never => {
    throw Object.assign(new Error('stub provider failure'), {
      url: 'https://api.example-provider.invalid/v1/chat/completions',
      statusCode: 400,
      requestBodyValues: { model: 'stub-model-1', messages: options?.prompt },
      responseBody: `{"error":{"message":"${PROVIDER_RESPONSE_CANARY}"}}`,
    });
  };

  return {
    specificationVersion: 'v2',
    provider: 'stub-provider',
    modelId: 'stub-model-1',
    supportedUrls: {},
    doGenerate: (options: { prompt?: unknown }) =>
      Promise.resolve(fail(options)),
    doStream: (options: { prompt?: unknown }) => Promise.resolve(fail(options)),
  };
}

type MastraAgentModel = ConstructorParameters<typeof Agent>[0]['model'];

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Mastra credential containment', () => {
  it('says nothing about the credential it was constructed with', async () => {
    const fetchSpy = forbidNetwork();
    const spies = captureConsole();

    const definition = {
      id: 'credential-containment-agent',
      version: 1,
      runtime: AGENT_RUNTIME_NAMES.mastra,
      instructions: SYSTEM_INSTRUCTIONS_CANARY,
      model: MODEL_IDS.openAiGpt4oMini,
      modelPolicy: {
        id: 'credential-containment-agent.model-policy.1',
        allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
      },
      input: z.unknown(),
      output: z.object({ answer: z.string() }),
    } satisfies AgentDefinition;

    const runtime = new MastraRuntime({
      secret: () => Promise.resolve(CREDENTIAL_CANARY),
    });

    const failure = await runtime
      .run({
        definition,
        model: MODEL_IDS.openAiGpt4oMini,
        configuration: {},
        input: USER_PROMPT_CANARY,
        context: [],
        tools: [],
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    const serialized = serializeConsole(spies);
    const total = totalConsoleCalls(spies);

    jest.restoreAllMocks();

    expect(failure).not.toBeNull();
    expect(total).toBe(0);
    expect(serialized).not.toContain(CREDENTIAL_CANARY);

    expect(
      inspect(failure, { depth: null, maxStringLength: null }),
    ).not.toContain(CREDENTIAL_CANARY);

    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('Mastra provider-material containment', () => {
  beforeAll(() => {
    expect(typeof Agent).toBe('function');
    expect(jest.isMockFunction(Agent)).toBe(false);
  });

  it('leaks instructions, prompt and provider response through console when uncontained', async () => {
    const fetchSpy = forbidNetwork();
    const spies = captureConsole();

    const agent = new Agent({
      id: 'containment-control-agent',
      name: 'containment-control-agent',
      instructions: SYSTEM_INSTRUCTIONS_CANARY,
      model: createLeakyStubModel() as unknown as MastraAgentModel,
    });

    await expect(agent.generate(USER_PROMPT_CANARY)).rejects.toThrow();

    const serialized = serializeConsole(spies);
    const counts = consoleCallCounts(spies);

    jest.restoreAllMocks();

    expect(counts.error).toBeGreaterThan(0);
    for (const canary of ALL_CANARIES) {
      expect(serialized).toContain(canary);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emits nothing after the runtime containment seam is applied', async () => {
    const fetchSpy = forbidNetwork();
    const agent = new Agent({
      id: 'containment-agent',
      name: 'containment-agent',
      instructions: SYSTEM_INSTRUCTIONS_CANARY,
      model: createLeakyStubModel() as unknown as MastraAgentModel,
    });

    const spies = captureConsole();
    containMastraAgent(agent);

    await expect(agent.generate(USER_PROMPT_CANARY)).rejects.toThrow();

    const serialized = serializeConsole(spies);
    const counts = consoleCallCounts(spies);
    const total = totalConsoleCalls(spies);

    jest.restoreAllMocks();

    expect(counts).toEqual({
      log: 0,
      info: 0,
      warn: 0,
      error: 0,
      debug: 0,
      trace: 0,
      dir: 0,
    });
    expect(total).toBe(0);
    for (const canary of ALL_CANARIES) {
      expect(serialized).not.toContain(canary);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the tool record the real SDK accepts', () => {
  const toolFor = (name: string) => ({
    name,
    description: 'Search knowledge.',
    input: z.object({ query: z.string() }).strict(),
    output: z.object({ passages: z.array(z.string()) }).strict(),
    execute: () => Promise.resolve({ passages: [] }),
  });

  const agentWith = (tools: Record<string, unknown>) =>
    new Agent({
      id: 'containment-agent',
      name: 'containment-agent',
      instructions: 'Answer.',
      model: { id: 'gpt-4o-mini', apiKey: 'not-a-real-key' } as never,
      tools: tools as never,
    });

  it('assigns exactly the authorized tools, under their audited names', async () => {
    const agent = agentWith(toMastraTools([toolFor('knowledge_search_v1')]));

    await expect(
      agent.listTools().then((listed) => Object.keys(listed).sort()),
    ).resolves.toEqual(['knowledge_search_v1']);
  });

  it('assigns nothing at all when the run was granted nothing', async () => {
    const agent = agentWith(toMastraTools([]));

    await expect(agent.listTools().then(Object.keys)).resolves.toEqual([]);
  });

  it('invokes the application closure through the real tool wrapper', async () => {
    const calls: unknown[] = [];
    const tool = {
      ...toolFor('knowledge_search_v1'),
      execute: (input: unknown) => {
        calls.push(input);
        return Promise.resolve({ passages: [] });
      },
    };
    const agent = agentWith(toMastraTools([tool]));
    const listed = (await agent.listTools()) as unknown as Record<
      string,
      { execute: (input: unknown, context: unknown) => Promise<unknown> }
    >;

    await listed.knowledge_search_v1?.execute(
      { query: 'refunds' },
      { requestContext: { orgId: 'org_2' } },
    );

    expect(calls).toEqual([{ query: 'refunds' }]);
  });
});

describe('provider-facing tool-error serialization', () => {
  beforeAll(() => {
    expect(typeof Agent).toBe('function');
    expect(jest.isMockFunction(Agent)).toBe(false);
    expect(jest.isMockFunction(createTool)).toBe(false);
  });

  const ORIGINAL_MESSAGE = 'CANARY_ORIGINAL_MESSAGE_m1m1';
  const ORIGINAL_NAME = 'CanaryPrismaKnownRequestError_n2n2';
  const ORIGINAL_CAUSE = 'CANARY_ORIGINAL_CAUSE_c3c3';
  const ORIGINAL_PROPERTY = 'CANARY_ORIGINAL_PROPERTY_p4p4';
  const DATABASE_HOST = 'canary-db.internal.invalid:5432';
  const PRISMA_INVOCATION =
    'Invalid `prisma.toolExecution.create()` invocation';
  const TOOL_OUTPUT_SECRET = 'CANARY_TOOL_OUTPUT_o5o5';

  const IMPLEMENTATION_SECRETS = [
    ORIGINAL_MESSAGE,
    ORIGINAL_NAME,
    ORIGINAL_CAUSE,
    ORIGINAL_PROPERTY,
    DATABASE_HOST,
    PRISMA_INVOCATION,
    TOOL_OUTPUT_SECRET,
  ] as const;

  function leakyDriverError(): Error {
    return Object.assign(
      new Error(
        `${PRISMA_INVOCATION}\n${ORIGINAL_MESSAGE} at ${DATABASE_HOST}`,
        { cause: new Error(ORIGINAL_CAUSE) },
      ),
      {
        name: ORIGINAL_NAME,
        code: 'P2002',
        clientVersion: '7.9.1',
        meta: { target: ORIGINAL_PROPERTY, output: TOOL_OUTPUT_SECRET },
      },
    );
  }

  const TOOL_REF: ToolRef = 'knowledge.search@1';

  const registry = () =>
    new ToolRegistry([
      {
        id: 'knowledge.search',
        version: 1,
        runtimeName: 'knowledge_search_v1',
        description: 'Search knowledge.',
        input: z.object({ query: z.string().min(1) }).strict(),
        output: z.object({ passages: z.array(z.string()) }).strict(),
        risk: 'read_only',
      },
      {
        id: 'notification.send',
        version: 1,
        runtimeName: 'notification_send_v1',
        description: 'Propose a notification.',
        input: z.object({ recipientMemberId: z.string() }).strict(),
        output: z.object({ status: z.literal('awaiting_approval') }).strict(),
        risk: 'side_effect',
      },
    ]);

  const sideEffectStub = {
    ref: 'notification.send@1' as ToolRef,
    kind: 'side_effect' as const,
    propose: () => Promise.resolve(),
    prepareEffect: () => Promise.reject(new Error('never')),
  };

  const agentDefinition = {
    id: 'containment-tool-agent',
    version: 1,
    runtime: AGENT_RUNTIME_NAMES.mastra,
    instructions: 'Answer.',
    model: MODEL_IDS.openAiGpt4oMini,
    modelPolicy: {
      id: 'containment-tool-agent.model-policy.1',
      allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
    },
    input: z.unknown(),
    output: z.unknown(),
    maxToolGrants: [TOOL_REF],
  } as unknown as AgentDefinition;

  const durableStub = (overrides: Record<string, unknown> = {}) =>
    ({
      start: () => Promise.resolve('execution-1'),
      succeed: () => Promise.resolve(),
      fail: () => Promise.resolve(),
      ...overrides,
    }) as never;

  function authorizedTools(
    execute: () => Promise<unknown>,
    durable = durableStub(),
  ) {
    const gateway = new ToolGateway(registry(), durable, [
      { ref: TOOL_REF, execute },
      sideEffectStub,
    ]);

    return gateway.authorize({
      definition: agentDefinition,
      organizationId: 'org_1',
      agentRunId: 'run_1',
      agentRunAttempt: 1,
      grants: [TOOL_REF],
    });
  }

  function recordingToolModel(prompts: unknown[]) {
    let call = 0;

    const respond = (options: { prompt?: unknown }) => {
      prompts.push(structuredClone(options.prompt ?? null));
      call += 1;

      if (call === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'knowledge_search_v1',
              input: '{"query":"refund policy"}',
            },
          ],
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }

      return {
        content: [{ type: 'text', text: 'answered' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    };

    return {
      specificationVersion: 'v2',
      provider: 'stub-provider',
      modelId: 'stub-model-1',
      supportedUrls: {},
      doGenerate: (o: { prompt?: unknown }) => Promise.resolve(respond(o)),
      doStream: (o: { prompt?: unknown }) => Promise.resolve(respond(o)),
    };
  }

  async function runFailingTool(tools: readonly AgentRuntimeTool[]) {
    const prompts: unknown[] = [];
    const chunks: Record<string, unknown>[] = [];
    const agent = new Agent({
      id: 'containment-tool-agent',
      name: 'containment-tool-agent',
      instructions: 'Answer.',
      model: recordingToolModel(prompts) as unknown as MastraAgentModel,
      tools: toMastraTools(tools) as never,
    });
    containMastraAgent(agent);

    await agent.generate('find the refund policy', {
      maxSteps: 4,
      onChunk: (chunk: unknown) => {
        chunks.push(chunk as Record<string, unknown>);
      },
    } as never);

    expect(prompts).toHaveLength(2);

    return { transcript: prompts[1], chunks };
  }

  async function transcriptAfterToolFailure(
    tools: readonly AgentRuntimeTool[],
  ) {
    return (await runFailingTool(tools)).transcript;
  }

  function reifiedToolError(chunks: Record<string, unknown>[]): Error {
    const chunk = chunks.find((entry) => entry.type === 'tool-error');

    expect(chunk).toBeDefined();

    const error = (chunk?.payload as { error?: unknown })?.error;

    expect(error).toBeInstanceOf(Error);

    return error as Error;
  }

  function toolResults(transcript: unknown): Record<string, unknown>[] {
    const messages = transcript as { content?: unknown }[];

    return messages.flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as Record<string, unknown>[]).filter(
            (part) => part?.type === 'tool-result',
          )
        : [],
    );
  }

  const dump = (value: unknown) =>
    inspect(value, {
      depth: null,
      maxStringLength: null,
      maxArrayLength: null,
    });

  it('leaks the driver error to the provider when the tool is uncontained', async () => {
    const transcript = await transcriptAfterToolFailure([
      {
        name: 'knowledge_search_v1',
        description: 'Search knowledge.',
        input: z.object({ query: z.string() }).strict(),
        output: z.object({ passages: z.array(z.string()) }).strict(),
        execute: () => Promise.reject(leakyDriverError()),
      },
    ]);

    const serialized = dump(transcript);

    expect(serialized).toContain(ORIGINAL_MESSAGE);
    expect(serialized).toContain(DATABASE_HOST);
    expect(serialized).toContain(PRISMA_INVOCATION);
  });

  it('transmits only the bounded application sentence when an implementation throws', async () => {
    const transcript = await transcriptAfterToolFailure(
      authorizedTools(() => Promise.reject(leakyDriverError())),
    );

    const results = toolResults(transcript);
    const serialized = dump(transcript);

    expect(results).toHaveLength(1);
    expect(results[0]?.output).toEqual({
      type: 'error-text',
      value: 'Tool "knowledge_search_v1" failed',
    });

    for (const secret of IMPLEMENTATION_SECRETS) {
      expect(serialized).not.toContain(secret);
    }

    expect(serialized).not.toContain('knowledge.search@1');
  });

  it('transmits only the bounded sentence when the durable write rejects', async () => {
    const transcript = await transcriptAfterToolFailure(
      authorizedTools(
        () => Promise.resolve({ passages: [] }),
        durableStub({ succeed: () => Promise.reject(leakyDriverError()) }),
      ),
    );

    const results = toolResults(transcript);
    const serialized = dump(transcript);

    expect(results[0]?.output).toEqual({
      type: 'error-text',
      value: 'Tool "knowledge_search_v1" could not be completed',
    });

    for (const secret of IMPLEMENTATION_SECRETS) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('transmits no stack frame from any source', async () => {
    const transcript = await transcriptAfterToolFailure(
      authorizedTools(() => Promise.reject(leakyDriverError())),
    );

    const serialized = dump(transcript);

    expect(serialized).not.toMatch(/\bat\s+\S+\s+\(/);
    expect(serialized).not.toMatch(/\bat\s+\/\S+:\d+:\d+/);
    expect(serialized).not.toContain('node_modules');
    expect(serialized).not.toContain('.ts:');
    expect(serialized).not.toContain('apps/control-plane');
    expect(serialized).not.toContain(process.cwd());
  });

  it('hands the SDK a failure whose stack names nothing of this application', async () => {
    const { chunks } = await runFailingTool(
      authorizedTools(() => Promise.reject(leakyDriverError())),
    );

    const error = reifiedToolError(chunks);

    expect(error.message).toContain('Tool "knowledge_search_v1" failed');
    expect(error.stack ?? '').not.toContain('apps/control-plane');

    const serialized = dump(error);

    for (const secret of IMPLEMENTATION_SECRETS) {
      expect(serialized).not.toContain(secret);
    }

    expect(serialized).not.toContain('apps/control-plane');
    expect(serialized).not.toContain('tool.gateway');
    expect(serialized).not.toContain(process.cwd());
  });

  it('names no application source when a synchronous refusal is serialized', async () => {
    const OVER_BUDGET = 13;
    const prompts: unknown[] = [];
    const chunks: Record<string, unknown>[] = [];
    let call = 0;

    const respond = (options: { prompt?: unknown }) => {
      prompts.push(structuredClone(options.prompt ?? null));
      call += 1;

      if (call === 1) {
        return {
          content: Array.from({ length: OVER_BUDGET }, (_unused, index) => ({
            type: 'tool-call',
            toolCallId: `call_${index + 1}`,
            toolName: 'knowledge_search_v1',
            input: '{"query":"refund policy"}',
          })),
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }

      return {
        content: [{ type: 'text', text: 'answered' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    };

    const agent = new Agent({
      id: 'containment-tool-agent',
      name: 'containment-tool-agent',
      instructions: 'Answer.',
      model: {
        specificationVersion: 'v2',
        provider: 'stub-provider',
        modelId: 'stub-model-1',
        supportedUrls: {},
        doGenerate: (o: { prompt?: unknown }) => Promise.resolve(respond(o)),
        doStream: (o: { prompt?: unknown }) => Promise.resolve(respond(o)),
      } as unknown as MastraAgentModel,
      tools: toMastraTools(
        authorizedTools(() => Promise.resolve({ passages: [] })),
      ) as never,
    });
    containMastraAgent(agent);

    await agent.generate('find the refund policy', {
      maxSteps: 4,
      onChunk: (chunk: unknown) => {
        chunks.push(chunk as Record<string, unknown>);
      },
    } as never);

    const errors = chunks
      .filter((chunk) => chunk.type === 'tool-error')
      .map((chunk) => (chunk.payload as { error: Error }).error);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(
      'Tool "knowledge_search_v1" exceeded this attempt\'s tool-call budget',
    );

    const stack = errors[0]?.stack ?? '';

    expect(stack).not.toContain('tool.gateway');
    expect(stack).not.toContain('apps/control-plane');
    expect(stack).not.toContain('mastra.containment');
    expect(dump(prompts[1])).not.toContain('apps/control-plane');
  });

  it('carries the driver material into the SDK failure when uncontained', async () => {
    const { chunks } = await runFailingTool([
      {
        name: 'knowledge_search_v1',
        description: 'Search knowledge.',
        input: z.object({ query: z.string() }).strict(),
        output: z.object({ passages: z.array(z.string()) }).strict(),
        execute: () => Promise.reject(leakyDriverError()),
      },
    ]);

    const error = reifiedToolError(chunks);

    expect(error.message).toContain(ORIGINAL_MESSAGE);
    expect(error.stack ?? '').toContain(ORIGINAL_MESSAGE);
    expect(dump(error)).toContain(DATABASE_HOST);
  });

  it('carries no stack and no own enumerable property to serialize', () => {
    const failure = new ToolExecutionFailure(
      'Tool "knowledge_search_v1" failed',
    );

    expect(failure.stack).toBeUndefined();
    expect(Object.hasOwn(failure, 'stack')).toBe(false);
    expect(failure.name).toBe('ToolExecutionFailure');
    expect(failure.message).toBe('Tool "knowledge_search_v1" failed');
    expect(Object.keys(failure)).toEqual([]);
    expect(JSON.stringify(failure)).toBe('{}');
    expect(dump(failure)).not.toContain('node_modules');
  });
});

describe('malformed tool-call arguments in application logs', () => {
  beforeAll(() => {
    expect(typeof Agent).toBe('function');
    expect(jest.isMockFunction(Agent)).toBe(false);
  });

  const USER_INPUT_CANARY = 'CANARY_USER_INPUT_ARG_u1u1';
  const KNOWLEDGE_CANARY = 'CANARY_KNOWLEDGE_PASSAGE_k2k2';
  const TENANT_CANARY = 'org_CANARY_TENANT_t3t3';

  const ARGUMENT_CANARIES = [
    USER_INPUT_CANARY,
    KNOWLEDGE_CANARY,
    TENANT_CANARY,
  ] as const;

  const TRUNCATED_ARGUMENTS =
    `{"query":"${USER_INPUT_CANARY} ${KNOWLEDGE_CANARY}` +
    ` for ${TENANT_CANARY}`;

  function modelEmitting(input: string) {
    let call = 0;

    const respond = () => {
      call += 1;

      if (call === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'knowledge_search_v1',
              input,
            },
          ],
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }

      return {
        content: [{ type: 'text', text: 'answered' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    };

    return {
      specificationVersion: 'v2',
      provider: 'stub-provider',
      modelId: 'stub-model-1',
      supportedUrls: {},
      doGenerate: () => Promise.resolve(respond()),
      doStream: () => Promise.resolve(respond()),
    };
  }

  async function generateWith(input: string) {
    const fetchSpy = forbidNetwork();
    const received: unknown[] = [];

    const rawSinks: unknown[] = [];
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        rawSinks.push(chunk);
        return true;
      });
    const stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        rawSinks.push(chunk);
        return true;
      });
    const warningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation((...args: unknown[]) => {
        rawSinks.push(args);
      });
    const agent = new Agent({
      id: 'tool-input-agent',
      name: 'tool-input-agent',
      instructions: 'Answer.',
      model: modelEmitting(input) as unknown as MastraAgentModel,
      tools: toMastraTools([
        {
          name: 'knowledge_search_v1',
          description: 'Search knowledge.',
          input: z.object({ query: z.string() }).strict(),
          output: z.object({ passages: z.array(z.string()) }).strict(),
          execute: (args) => {
            received.push(args);
            return Promise.resolve({ passages: [] });
          },
        },
      ]) as never,
    });
    containMastraAgent(agent);

    const spies = captureConsole();

    await agent.generate('find the refund policy', { maxSteps: 3 });

    const serialized = serializeConsole(spies);
    const total = totalConsoleCalls(spies);
    const raw = inspect(rawSinks, { depth: null, maxStringLength: null });

    jest.restoreAllMocks();
    void stderrSpy;
    void stdoutSpy;
    void warningSpy;

    expect(fetchSpy).not.toHaveBeenCalled();

    return { serialized, total, received, raw };
  }

  it('writes no part of a malformed tool argument to the console', async () => {
    const { serialized, raw } = await generateWith(TRUNCATED_ARGUMENTS);

    for (const canary of ARGUMENT_CANARIES) {
      expect(serialized).not.toContain(canary);
    }

    expect(serialized).not.toContain(TRUNCATED_ARGUMENTS);
    expect(serialized).not.toContain('"query"');
    expect(serialized).not.toContain('Error converting tool call input');

    for (const canary of ARGUMENT_CANARIES) {
      expect(raw).not.toContain(canary);
    }
  });

  it('writes only a bounded diagnostic, if anything at all', async () => {
    const { serialized, total } = await generateWith(TRUNCATED_ARGUMENTS);

    expect(total).toBe(1);
    expect(serialized).toContain('Tool call input could not be parsed');

    expect(serialized).not.toContain('apps/control-plane');
    expect(serialized).not.toContain('node_modules');
    expect(serialized).not.toContain(process.cwd());
    expect(serialized).not.toMatch(/\bat\s+\S+\s+\(/);
  });

  it('still delivers a valid tool call to the application closure', async () => {
    const { received, serialized } = await generateWith(
      `{"query":"${USER_INPUT_CANARY}"}`,
    );

    expect(received).toEqual([{ query: USER_INPUT_CANARY }]);
    expect(serialized).not.toContain('could not be parsed');
  });

  it('still repairs recoverable malformed arguments', async () => {
    const { received, serialized } = await generateWith(
      `{query:'${USER_INPUT_CANARY}',}`,
    );

    expect(received).toEqual([{ query: USER_INPUT_CANARY }]);
    expect(serialized).not.toContain('could not be parsed');
    expect(serialized).not.toContain(USER_INPUT_CANARY);
  });
});
