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

import { containMastraAgent, MastraRuntime } from '../mastra.runtime';

import {
  AGENT_RUNTIME_NAMES,
  type AgentDefinition,
} from '../../../agent.types';
import { MODEL_IDS } from '../../../../model-catalog/model-catalog';

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
      input: z.unknown(),
      output: z.object({ answer: z.string() }),
    } satisfies AgentDefinition;

    const runtime = new MastraRuntime({
      secret: () => Promise.resolve(CREDENTIAL_CANARY),
    } as never);

    /**
     * Rejects because `fetch` is forbidden, which is the point: the run gets
     * all the way to the transport with a real credential on the config, and
     * then fails the way a network outage would.
     */
    const failure = await runtime
      .run({
        definition,
        configuration: {},
        input: USER_PROMPT_CANARY,
        context: [],
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
