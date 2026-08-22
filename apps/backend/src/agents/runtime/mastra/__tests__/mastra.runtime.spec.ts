import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

/**
 * Mocks `@mastra/core/agent` wholesale to test the adapter's input/output
 * conversion and its logger installation cheaply and in isolation.
 *
 * Do not merge this file with `mastra.containment.spec.ts`. That suite proves
 * the logger containment against the real SDK, and a module mock applies to a
 * whole file, so combining them would silently make the containment claim
 * vacuous. Here the injected logger's discard behavior is asserted directly;
 * the sibling suite asserts the effect on the real console.
 */
const generate = jest.fn<(prompt: string) => Promise<{ text: string }>>();
const setLogger = jest.fn<(logger: unknown) => void>();
const Agent = jest.fn<
  (config: Record<string, string>) => {
    generate: typeof generate;
    __setLogger: typeof setLogger;
  }
>(() => ({ generate, __setLogger: setLogger }));

jest.unstable_mockModule('@mastra/core/agent', () => ({ Agent }));

let MastraRuntime: typeof import('../mastra.runtime').MastraRuntime;

beforeAll(async () => {
  ({ MastraRuntime } = await import('../mastra.runtime'));
});

beforeEach(() => {
  Agent.mockClear();
  setLogger.mockClear();
  generate.mockReset();
});

describe('MastraRuntime', () => {
  it('converts application input and output without a provider request', async () => {
    generate.mockResolvedValue({ text: 'runtime output' });
    const runtime = new MastraRuntime();
    const definition = {
      id: 'test-agent',
      version: 1,
      runtime: 'mastra',
      instructions: 'Test instructions',
      model: 'test/provider-model',
    } as const;

    await expect(
      runtime.run({
        definition,
        input: { z: 1, nested: { z: 3, a: 2 }, a: true },
      }),
    ).resolves.toEqual({ output: 'runtime output' });

    expect(Agent).toHaveBeenCalledWith({
      id: definition.id,
      name: definition.id,
      instructions: definition.instructions,
      model: definition.model,
    });
    expect(generate).toHaveBeenCalledWith(
      '{"a":true,"nested":{"a":2,"z":3},"z":1}',
    );
  });

  it('replaces the SDK console logger before any provider call', async () => {
    generate.mockResolvedValue({ text: 'runtime output' });
    const runtime = new MastraRuntime();

    await runtime.run({
      definition: {
        id: 'test-agent',
        version: 1,
        runtime: 'mastra',
        instructions: 'Test instructions',
        model: 'test/provider-model',
      },
      input: 'hello',
    });

    // Mastra's default ConsoleLogger writes raw provider errors — request body,
    // response body, endpoint, model — straight to console.error, bypassing the
    // application's redaction. The injected logger must discard them.
    expect(setLogger).toHaveBeenCalledTimes(1);

    const injected = setLogger.mock.calls[0]?.[0] as Record<
      string,
      (...args: unknown[]) => unknown
    >;

    expect(() =>
      injected.error('Upstream LLM API error', {
        responseBody: 'provider secret',
      }),
    ).not.toThrow();
    expect(injected.error('x', { responseBody: 'y' })).toBeUndefined();
  });
});
