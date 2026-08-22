import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { inspect } from 'node:util';

import { Agent } from '@mastra/core/agent';

import { MastraRuntime } from '../mastra.runtime';
import {
  AGENT_RUNTIME_NAMES,
  type AgentDefinition,
} from '../../../agent.types';

/**
 * Runs against the REAL `@mastra/core`, unlike `mastra.runtime.spec.ts`, which
 * mocks `@mastra/core/agent` wholesale to test input/output conversion cheaply.
 * The two must stay in separate files: a module mock in this one would make the
 * containment claim vacuous, because the thing being contained is the SDK's own
 * logging behavior.
 *
 * No network and no provider credential is involved. `new Agent()` performs no
 * I/O, model resolution is lazy, and the model here is a local stub that throws
 * a provider-shaped error before any transport would be used. Every test also
 * asserts that `fetch` was never called, so a future SDK that did reach out
 * would fail the suite rather than silently depend on the network.
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

  it('emits nothing to any console sink when run through MastraRuntime', async () => {
    const fetchSpy = forbidNetwork();

    const definition = {
      id: 'containment-agent',
      version: 1,
      runtime: AGENT_RUNTIME_NAMES.mastra,
      instructions: SYSTEM_INSTRUCTIONS_CANARY,
      /**
       * The only cast here. `AgentDefinition.model` is typed `string` as a
       * deliberate application constraint — definitions are declarative and
       * serializable — while Mastra itself accepts a `LanguageModelV2` object.
       * Passing the stub is what keeps this test offline and key-free; the cast
       * exists solely to bridge our narrower type to the SDK's wider one.
       */
      model: createLeakyStubModel() as unknown as string,
    } satisfies AgentDefinition;

    const spies = captureConsole();

    await expect(
      new MastraRuntime().run({ definition, input: USER_PROMPT_CANARY }),
    ).rejects.toThrow();

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
