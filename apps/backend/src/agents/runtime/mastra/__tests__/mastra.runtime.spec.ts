import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const generate = jest.fn<(prompt: string) => Promise<{ text: string }>>();
const Agent = jest.fn<
  (config: Record<string, string>) => { generate: typeof generate }
>(() => ({ generate }));

jest.unstable_mockModule('@mastra/core/agent', () => ({ Agent }));

let MastraRuntime: typeof import('../mastra.runtime').MastraRuntime;

beforeAll(async () => {
  ({ MastraRuntime } = await import('../mastra.runtime'));
});

beforeEach(() => {
  Agent.mockClear();
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
});
