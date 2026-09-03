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

/**
 * Runs against the REAL `@mastra/core`, unlike `mastra.runtime.spec.ts`, which
 * mocks `@mastra/core/agent` wholesale to test input/output conversion cheaply.
 * The two must stay in separate files: a module mock in this one would make the
 * containment claim vacuous, because the thing being contained is the SDK's own
 * logging behavior.
 *
 * Hermetic throughout: `fetch` is replaced in every test, so nothing here can
 * become a live call. The two provider-material tests never reach the network
 * at all — their model is a local stub that throws a provider-shaped error
 * first — and assert `fetch` was never called, so a future SDK that started
 * reaching out would fail the suite rather than quietly depend on it. The
 * credential test is the deliberate exception: it goes all the way to the
 * transport with a key on the config, because that is the only way to observe
 * what the SDK says about one, and the forbidden `fetch` is what stops it
 * there.
 *
 * No real credential is involved anywhere. The canaries below are the only
 * secret-shaped strings in the file.
 */

/**
 * Obviously-fake markers, never anything resembling a real secret. Each one
 * stands for a distinct class of provider material that must not reach stdout:
 * the agent's system instructions, the caller's prompt (derived from
 * `AgentRun.input`), and the provider's response body.
 */
const SYSTEM_INSTRUCTIONS_CANARY = 'CANARY_SYSTEM_INSTRUCTIONS_a1b2c3';
const USER_PROMPT_CANARY = 'CANARY_USER_PROMPT_d4e5f6';
const PROVIDER_RESPONSE_CANARY = 'CANARY_PROVIDER_RESPONSE_BODY_9z8y7x';
/** Obviously fake, and shaped like a key only so a leak is recognizable. */
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

/**
 * Spies on every console sink Mastra's `ConsoleLogger` can reach, suppressing
 * real output so a leak is captured rather than printed into the test run.
 */
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

/**
 * Serializes captured arguments deeply. `JSON.stringify` would hide the payload
 * this test is about: the leaked material rides on non-enumerable `Error`
 * fields and nested objects, so `inspect` with unlimited depth is what actually
 * proves presence or absence.
 */
function serializeConsole(spies: ConsoleSpies): string {
  return inspect(
    CONSOLE_METHODS.map((method) => [method, spies[method].mock.calls]),
    { depth: null, maxStringLength: null, maxArrayLength: null },
  );
}

/** Rejects any outbound request so a hermetic test cannot become a live one. */
function forbidNetwork(): jest.Spied<typeof fetch> {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access attempted in a hermetic containment test');
  });
}

/**
 * A local `LanguageModelV2`-shaped stub that fails the way a real provider does.
 *
 * The AI SDK's `APICallError` carries the outbound request body, the endpoint,
 * the status and the raw response body. Mastra's agent loop hands that whole
 * object to `this.logger.error`, which is precisely the leak under test, so the
 * stub reproduces those fields instead of throwing a bare `Error`.
 */
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

/**
 * Mastra's own `MastraModelConfig` union includes `LanguageModelV2`, so an
 * object model is supported by the SDK; only its compile-time position needs
 * help, because the stub is structurally typed rather than branded.
 */
type MastraAgentModel = ConstructorParameters<typeof Agent>[0]['model'];

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * The fourth class of provider material, and the one the two tests below
 * cannot see.
 *
 * Both of them pass a stub model object, which never reaches credential
 * resolution — deliberately, since that is what keeps them offline. But a real
 * run puts a decrypted key on the model config handed to `new Agent(...)`, and
 * that value is on a path neither test exercises. A diagnostic that serialized
 * the model config, or an SDK whose construction started describing what it
 * was given, would leak it with the rest of this file green.
 *
 * So this one constructs the real thing the way `MastraRuntime` does, with a
 * provider string and a resolved credential, and asserts the console stayed
 * silent. It performs no request: `new Agent()` does no I/O and model
 * resolution is lazy, and `fetch` is forbidden to prove it.
 */
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

    /**
     * Rejects because `fetch` is forbidden, which is the point: the run gets
     * all the way to the transport with a real credential on the config, and
     * then fails the way a network outage would.
     */
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

    /**
     * And not on the thrown value either. `AgentExecutionHandler` never
     * serializes what it caught — the run's diagnostic is a constant — but the
     * value still travels through BullMQ's failure path, so a key riding on it
     * would be one `logger.error(error)` away from the container logs.
     */
    expect(
      inspect(failure, { depth: null, maxStringLength: null }),
    ).not.toContain(CREDENTIAL_CANARY);

    // The credential went to the SDK, and the SDK tried to use it.
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('Mastra provider-material containment', () => {
  beforeAll(() => {
    // Fails loudly if the SDK ever stops resolving, so neither test below can
    // pass against an absent or mocked `@mastra/core`.
    expect(typeof Agent).toBe('function');
    expect(jest.isMockFunction(Agent)).toBe(false);
  });

  /**
   * Inverted control. This asserts the leak EXISTS in an uncontained agent, so
   * the containment test that follows is a regression detector rather than a
   * tautology.
   *
   * If this test ever fails because nothing leaked, do not delete it and do not
   * relax it: the SDK's default logging changed, the containment test has
   * become vacuous, and both tests need to be rebuilt against the new behavior.
   */
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

/**
 * The adapter's tool record, accepted by the real SDK.
 *
 * What this proves and what it does not, stated precisely, because the
 * distinction is easy to overclaim. `Agent.listTools()` resolves the *assigned*
 * tools — `this.tools` — and applies neither `convertTools`' nine-source merge
 * nor `formatTools`' key sanitiser. Both of those run later, inside a
 * generation, and no public surface exposes their result without a provider
 * call. So the merged set is asserted from the constructor arguments in
 * `mastra.runtime.spec.ts`, and cannot be asserted here.
 *
 * What this does prove is not available in that sibling suite, which mocks
 * `@mastra/core/agent` wholesale: that `toMastraTools` produces a record the
 * real `Agent` accepts, and that the real SDK reports back exactly the audited
 * names it was given. A version bump that changed the accepted tool shape would
 * fail here and nowhere else.
 */
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

  /**
   * The real tool wrapper invokes the application closure with the model's
   * arguments and nothing else.
   *
   * `createTool` is not mocked in either suite, but only here is the resulting
   * `Tool` reached through an `Agent` the SDK actually built.
   */
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

/**
 * What a failed tool actually sends to the provider, measured end to end.
 *
 * This is the suite the containment claim rests on, and it is here rather than
 * beside `ToolGateway`'s unit tests for one reason: the thing being contained
 * is the installed SDK's own error serialization, and the sibling gateway suite
 * asserts against a mocked runtime, where the transcript does not exist. What
 * matters is not that the gateway throws a tidy error — it is what
 * `@mastra/core` turns that error into and hands the model on the next step.
 *
 * The seam is real throughout. A real `ToolRegistry` and a real `ToolGateway`
 * produce the closure; the real `toMastraTools` wraps it with the real
 * `createTool`; a real `Agent` runs the real agentic loop. Only the model is a
 * stub, and only so the transcript can be read: it emits a tool call on the
 * first request and records the prompt of every request, so the second one is
 * the verbatim message array a provider would have received.
 *
 * `MastraRuntime.run` is not used because it resolves a credential and builds a
 * provider-string model config, which cannot be pointed at a local stub. Every
 * line between the gateway and the transcript is exercised regardless; the
 * runtime's own contribution to a tool call — the tool record and the step
 * ceiling — is asserted in `mastra.runtime.spec.ts`.
 */
describe('provider-facing tool-error serialization', () => {
  /**
   * The same guard the suite above uses. Every claim in this block is about
   * what `@mastra/core` does with a thrown error, so a module mock reaching
   * this file would make all of it vacuous while leaving it green.
   */
  beforeAll(() => {
    expect(typeof Agent).toBe('function');
    expect(jest.isMockFunction(Agent)).toBe(false);
    expect(jest.isMockFunction(createTool)).toBe(false);
  });

  /**
   * The classes of material an implementation failure can carry, each a
   * distinct marker so a leak names its own source.
   *
   * Modelled on a Prisma rejection because that is the motivating case: its
   * message renders the connection target and, for an argument fault, the
   * invocation arguments — which at that point are the tool's input or output.
   */
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

  /**
   * A rejection shaped like the ones this path really sees: a message naming
   * the connection target and the invocation, a `cause`, own enumerable
   * properties, and a genuine stack rooted in this repository.
   */
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
      // Declared, so the registry is complete; never granted here.
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

  /**
   * The durable side, stubbed per test so both ways it can fail are reachable:
   * an implementation that throws, and a terminal write that refuses.
   */
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

  /**
   * Emits one tool call, then answers. Records the prompt of every request, so
   * `prompts[1]` is the transcript the provider sees after the tool failed.
   */
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

  /**
   * Runs one tool-calling generation and returns both sinks the SDK exposes.
   *
   * `transcript` is the message array of the request that follows the failed
   * tool call — what a provider receives. `chunks` are the SDK's own stream
   * events, and the `tool-error` one among them carries the error reified from
   * `serializeToolError`: the failure representation *before* any decision
   * about how to render it to the model. The two are asserted separately
   * because they are bounded by different things.
   */
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

  /** The transcript of the request that follows the failed tool call. */
  async function transcriptAfterToolFailure(
    tools: readonly AgentRuntimeTool[],
  ) {
    return (await runFailingTool(tools)).transcript;
  }

  /**
   * The error the SDK reified from its own `serializeToolError` output.
   *
   * This is stage 1 of the two-stage path: whatever survives here is what every
   * downstream consumer — the model renderer, `onChunk`, a persisted message
   * list — is working from.
   */
  function reifiedToolError(chunks: Record<string, unknown>[]): Error {
    const chunk = chunks.find((entry) => entry.type === 'tool-error');

    expect(chunk).toBeDefined();

    const error = (chunk?.payload as { error?: unknown })?.error;

    expect(error).toBeInstanceOf(Error);

    return error as Error;
  }

  /** Every `tool-result` the provider was handed, across all message roles. */
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

  /**
   * Inverted control, exactly as above. An UNCONTAINED tool — one that lets the
   * driver error escape — must leak, or the containment test below proves
   * nothing.
   *
   * If this ever fails because nothing leaked, do not delete it and do not
   * relax it: the SDK's serialization changed and both tests need rebuilding.
   */
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

  /**
   * The regression. A gateway-wrapped implementation that throws the same
   * driver error transmits the application's own sentence and nothing else.
   */
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

    /**
     * The failure names the tool the way the model was offered it. The durable
     * `id@version` is what `ToolExecution` records and what a grant selects; it
     * is not what the model knows this tool as, and `ToolDefinition.runtimeName`
     * exists precisely to keep the two apart.
     */
    expect(serialized).not.toContain('knowledge.search@1');
  });

  /**
   * The other way this path fails, and the one a mocked durable service hides:
   * the implementation succeeds and the terminal write rejects. Prisma's
   * rejection is then the value in hand, and it is the tool's own output that
   * its message would render.
   */
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

  /**
   * No stack frame of any origin reaches the transcript.
   *
   * Deliberately not the stack regression, and it would be wrong to read it as
   * one: `"text"` mode sends the provider `error.message` alone, so no stack
   * reaches a transcript under any configuration and an uncontained tool
   * satisfies every assertion below. What it does prove is that the *message*
   * is a constant with nothing frame-shaped in it, which is what keeps the
   * transcript clean. The stack itself is protected one layer down, in the
   * `cause` assertions of the stage-1 test above.
   *
   * The assertions are structural rather than canary-based because a stack is a
   * class of string nobody enumerates in advance.
   */
  it('transmits no stack frame from any source', async () => {
    const transcript = await transcriptAfterToolFailure(
      authorizedTools(() => Promise.reject(leakyDriverError())),
    );

    const serialized = dump(transcript);

    // A V8 frame, in either of its forms.
    expect(serialized).not.toMatch(/\bat\s+\S+\s+\(/);
    expect(serialized).not.toMatch(/\bat\s+\/\S+:\d+:\d+/);
    // Anything naming this repository or its dependencies.
    expect(serialized).not.toContain('node_modules');
    expect(serialized).not.toContain('.ts:');
    expect(serialized).not.toContain('apps/backend');
    expect(serialized).not.toContain(process.cwd());
  });

  /**
   * The same claim one stage earlier, against the SDK's own serializer.
   *
   * The transcript test above passes even without the stack fix, because
   * `"text"` mode reads only `message` — so on its own it would prove the
   * message is a constant, not that the failure carries no stack. This one is
   * the regression that fails when the stack comes back: it reads the error
   * `@mastra/core` built from `serializeToolError`, which copies `name`,
   * `message` and `stack` verbatim.
   *
   * A reified error always has *a* stack, because `deserializeToolError` calls
   * `new Error(message)` when the serialized stack is absent. The assertion is
   * therefore about whose frames those are: the SDK's own, never this
   * application's. An uncontained failure would put `tool.gateway` and this
   * repository's paths here.
   */
  it('hands the SDK a failure whose stack names nothing of this application', async () => {
    const { chunks } = await runFailingTool(
      authorizedTools(() => Promise.reject(leakyDriverError())),
    );

    const error = reifiedToolError(chunks);

    /**
     * `error` here is the SDK's `MastraError` wrapper, not the thrown
     * `ToolExecutionFailure`: `Tool.execute`'s catch wraps first and
     * `serializeToolError` runs on the wrapper. So `error.stack` is always
     * `@mastra/core`'s own frames and asserting on it proves little — but the
     * wrapper keeps the application error as `cause`, which is where a
     * restored stack would surface.
     */
    expect(error.message).toContain('Tool "knowledge_search_v1" failed');
    expect(error.stack ?? '').not.toContain('apps/backend');

    const serialized = dump(error);

    for (const secret of IMPLEMENTATION_SECRETS) {
      expect(serialized).not.toContain(secret);
    }

    /**
     * The detector for the stack containment, and the only one in this suite
     * that reads the path a leak would actually take. `dump` recurses into
     * `cause`; restoring `ToolExecutionFailure`'s stack puts this repository's
     * source paths here and fails exactly these three lines.
     */
    expect(serialized).not.toContain('apps/backend');
    expect(serialized).not.toContain('tool.gateway');
    expect(serialized).not.toContain(process.cwd());
  });

  /**
   * The other kind of failure: a refusal raised before any `await`, and one
   * the model can provoke without an implementation failing at all.
   *
   * Worth covering separately because its stack is the one most likely to name
   * this application. A failure raised in the `catch` around `await
   * implementation.execute(...)` has already lost its synchronous frames, so
   * V8 roots it at the SDK's await point; the per-attempt budget is checked at
   * the top of `ToolGateway.attempt`, where `tool.gateway.ts` and this
   * repository's directory layout are still on the stack at construction time.
   *
   * Reaching it needs no exotic setup. The SDK executes every tool call an
   * assistant step emits and bounds only their concurrency, so one step
   * emitting more calls than the budget allows is exactly the case the budget
   * exists for — which makes this a regression for the budget as well as for
   * the containment.
   */
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

    // The budget is twelve, so the thirteenth call in the step is refused.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(
      'Tool "knowledge_search_v1" exceeded this attempt\'s tool-call budget',
    );

    const stack = errors[0]?.stack ?? '';

    expect(stack).not.toContain('tool.gateway');
    expect(stack).not.toContain('apps/backend');
    expect(stack).not.toContain('mastra.containment');
    expect(dump(prompts[1])).not.toContain('apps/backend');
  });

  /**
   * The inverted control for the stage-1 assertions, so they cannot pass
   * vacuously: an uncontained tool must put the driver's material on the
   * reified error, message and stack header alike.
   */
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
    // The stack's own header embeds the message, so a transmitted stack is a
    // transmitted message even before its frames are read.
    expect(error.stack ?? '').toContain(ORIGINAL_MESSAGE);
    expect(dump(error)).toContain(DATABASE_HOST);
  });

  /**
   * The stack regression, and the only test that detects it.
   *
   * Stated plainly, because the alternative is a claim this suite does not
   * support: none of the real-SDK tests above fail if `ToolExecutionFailure`
   * keeps its stack. Two independent things hide it. `"text"` mode sends the
   * provider `error.message` and nothing else, and `deserializeToolError`
   * rebuilds the error with `new Error(message)` on this path, so the reified
   * object's frames are the SDK's own either way. Both were measured, not
   * assumed.
   *
   * What that means is that the seam proves the *outcome* — no application
   * material reaches the provider or the SDK's failure object — while this test
   * protects the *mechanism*. The mechanism still matters, because
   * `serializeToolError` in the installed bundle does read `error.stack` and
   * does put it in the representation that travels through the workflow result
   * and every consumer of it. An application stack is one SDK change away from
   * being carried, and nothing in the seam would report it.
   *
   * So this asserts the invariant at the exact object the serializer consumes:
   * no stack to copy, no own enumerable property for its spread to pick up, and
   * a bounded `name`. `JSON.stringify` is included because that is what `"json"`
   * mode emits, which is the mode a `providerExecuted` tool would take.
   */
  it('carries no stack and no own enumerable property to serialize', () => {
    const failure = new ToolExecutionFailure(
      'Tool "knowledge_search_v1" failed',
    );

    expect(failure.stack).toBeUndefined();
    expect(Object.hasOwn(failure, 'stack')).toBe(false);
    expect(failure.name).toBe('ToolExecutionFailure');
    expect(failure.message).toBe('Tool "knowledge_search_v1" failed');
    // What the SDK's spread over `Object.entries(error)` would contribute.
    expect(Object.keys(failure)).toEqual([]);
    // What `"json"` mode's `JSON.stringify` would emit.
    expect(JSON.stringify(failure)).toBe('{}');
    expect(dump(failure)).not.toContain('node_modules');
  });
});

/**
 * The other direction: what a tool *call* can put in this application's logs.
 *
 * Every suite above follows application material outbound to a provider. This
 * one follows model material inbound to stdout, and it exists because the two
 * are not the same boundary and only one of them was defended.
 *
 * `convertFullStreamChunkToMastra` (`dist/stream-BZ38co-u.js`, and the same
 * function in the `.cjs` bundle) converts each AI SDK stream chunk into a
 * Mastra one. For a `tool-call` it parses the model's argument string, and when
 * both `JSON.parse` and `tryRepairJson` fail it reaches for `console.error`
 * directly:
 *
 *     console.error("Error converting tool call input to JSON",
 *                   { input: value.input })
 *
 * That is a bare global call inside a pure transform. It takes no logger, `ctx`
 * carries only `runId`, and nothing gates it — so `containMastraAgent` cannot
 * reach it, `agent.__setLogger` cannot reach it, and because it never enters
 * Pino it is not redacted. The argument string it prints is model-generated
 * text composed *after* the model was shown the organization's knowledge
 * passages by `toPrompt`, so a query quoting a tenant document lands verbatim
 * in worker container logs.
 *
 * Reaching it needs no adversary. `tryRepairJson` fixes unquoted keys, single
 * quotes, trailing commas and bare dates; it cannot close a truncated object or
 * string. `GENERATION_BUDGET.maxOutputTokens` is 2000, so a tool call cut off
 * mid-argument is an ordinary outcome, and that is exactly the input this line
 * prints. Before tools existed the line was unreachable, which is why it
 * belongs to the change that introduced them.
 *
 * The remediation is a pnpm patch pinned to `@mastra/core@1.61.0`
 * (`patches/@mastra__core@1.61.0.patch`) replacing that one emission in both
 * bundles with a bounded constant carrying no value. No supported option, hook
 * or newer release avoids it — 1.63.2, the newest at the time of writing, has
 * the identical line. See `docs/backend.md`.
 *
 * These tests are the patch's regression. They run against the installed
 * package, so if the patch is dropped, unapplied, or silently defeated by an
 * upgrade, the canary reappears here.
 */
describe('malformed tool-call arguments in application logs', () => {
  beforeAll(() => {
    expect(typeof Agent).toBe('function');
    expect(jest.isMockFunction(Agent)).toBe(false);
  });

  /**
   * Each canary stands for a class of material the model can be induced to put
   * in a tool argument: what the caller typed, what retrieval handed it, and
   * the tenant it belongs to.
   */
  const USER_INPUT_CANARY = 'CANARY_USER_INPUT_ARG_u1u1';
  const KNOWLEDGE_CANARY = 'CANARY_KNOWLEDGE_PASSAGE_k2k2';
  const TENANT_CANARY = 'org_CANARY_TENANT_t3t3';

  const ARGUMENT_CANARIES = [
    USER_INPUT_CANARY,
    KNOWLEDGE_CANARY,
    TENANT_CANARY,
  ] as const;

  /**
   * Truncated mid-string, which is what `maxOutputTokens` produces and what
   * `tryRepairJson` provably cannot recover: it closes no brace and no quote.
   */
  const TRUNCATED_ARGUMENTS =
    `{"query":"${USER_INPUT_CANARY} ${KNOWLEDGE_CANARY}` +
    ` for ${TENANT_CANARY}`;

  /** Emits one tool call carrying `input`, then answers. */
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

  /**
   * Runs one generation whose single tool call carries `input`, with every
   * console sink captured, and reports what the tool actually received.
   */
  async function generateWith(input: string) {
    const fetchSpy = forbidNetwork();
    const received: unknown[] = [];

    /**
     * `console` is not the whole surface. The bundled AI SDK already prefers
     * `process.emitWarning` over `console.warn` for its own warnings, and a
     * direct `process.stderr.write` would bypass both. Neither is used on this
     * path today — which is the point of watching them: if an upstream change
     * moved the emission to either sink, the canary assertions below would
     * otherwise go quiet rather than fail.
     */
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

  /**
   * The regression. A truncated tool call reaches the unrepairable branch and
   * puts none of the model's argument text on any console sink.
   */
  it('writes no part of a malformed tool argument to the console', async () => {
    const { serialized, raw } = await generateWith(TRUNCATED_ARGUMENTS);

    for (const canary of ARGUMENT_CANARIES) {
      expect(serialized).not.toContain(canary);
    }

    // Not merely the canaries: no fragment of the raw argument string, and
    // nothing describing it.
    expect(serialized).not.toContain(TRUNCATED_ARGUMENTS);
    expect(serialized).not.toContain('"query"');
    expect(serialized).not.toContain('Error converting tool call input');

    // And nothing on the sinks that bypass `console` entirely.
    for (const canary of ARGUMENT_CANARIES) {
      expect(raw).not.toContain(canary);
    }
  });

  /**
   * And nothing else rides along on that path either — the diagnostic must not
   * grow a payload of tenant identity, credentials or source paths.
   */
  it('writes only a bounded diagnostic, if anything at all', async () => {
    const { serialized, total } = await generateWith(TRUNCATED_ARGUMENTS);

    /**
     * Exactly one emission, asserted verbatim.
     *
     * Not `<= 1` with a conditional body: that would pass if the SDK stopped
     * reaching this branch at all, and a containment test that goes quiet when
     * the code path disappears is proving nothing. Requiring the line means
     * this test also asserts the branch is still driven — so if a future
     * version repairs truncated JSON, or moves the emission, it fails here and
     * gets re-derived rather than silently becoming vacuous.
     *
     * The exact string is pinned because "a bounded diagnostic" is only a real
     * bound if it is; a patch that started interpolating anything fails.
     */
    expect(total).toBe(1);
    expect(serialized).toContain('Tool call input could not be parsed');

    expect(serialized).not.toContain('apps/backend');
    expect(serialized).not.toContain('node_modules');
    expect(serialized).not.toContain(process.cwd());
    expect(serialized).not.toMatch(/\bat\s+\S+\s+\(/);
  });

  /**
   * The patch must not have bought containment by breaking the feature. A
   * well-formed call still parses, still reaches the application closure, and
   * still arrives with exactly the model's arguments.
   */
  it('still delivers a valid tool call to the application closure', async () => {
    const { received, serialized } = await generateWith(
      `{"query":"${USER_INPUT_CANARY}"}`,
    );

    expect(received).toEqual([{ query: USER_INPUT_CANARY }]);
    // The happy path says nothing at all.
    expect(serialized).not.toContain('could not be parsed');
  });

  /**
   * The repair path is untouched too: malformed-but-recoverable arguments are
   * still repaired rather than dropped, so the patch removed an emission and
   * not a behaviour.
   */
  it('still repairs recoverable malformed arguments', async () => {
    const { received, serialized } = await generateWith(
      `{query:'${USER_INPUT_CANARY}',}`,
    );

    expect(received).toEqual([{ query: USER_INPUT_CANARY }]);
    expect(serialized).not.toContain('could not be parsed');
    expect(serialized).not.toContain(USER_INPUT_CANARY);
  });
});
