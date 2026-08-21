import { describe, expect, it, jest } from '@jest/globals';

import { AgentDefinitionRegistry } from '../agent-definition.registry';
import type { AgentRuntime } from '../agent-runtime';
import { AgentRuntimeRegistry } from '../agent-runtime.registry';
import { AgentRunner } from '../agent-runner.service';
import { MastraRuntime } from '../runtime/mastra/mastra.runtime';

const definition = {
  id: 'test-support-agent',
  runtime: 'mastra',
  instructions: 'Answer test requests.',
  model: 'test/provider-model',
} as const;

describe('AgentRunner', () => {
  it('selects the definition runtime and passes only application-owned data', async () => {
    const run = jest
      .fn<(request: unknown) => Promise<{ output: string }>>()
      .mockResolvedValue({ output: 'done' });
    const runtime: AgentRuntime = {
      name: 'mastra',
      run: (request) => run(request),
    };
    const resolve = jest.fn<(name: string) => AgentRuntime>(() => runtime);
    const runtimes = { resolve } as unknown as AgentRuntimeRegistry;
    const runner = new AgentRunner(
      new AgentDefinitionRegistry([definition]),
      runtimes,
    );

    await expect(
      runner.run({
        agentId: definition.id,
        runtime: 'mastra',
        input: { question: 'hello' },
      }),
    ).resolves.toEqual({ output: 'done' });

    expect(resolve).toHaveBeenCalledWith('mastra');
    expect(run).toHaveBeenCalledWith({
      definition,
      input: { question: 'hello' },
    });
  });

  it('rejects a persisted runtime that differs from the definition', async () => {
    const resolve = jest.fn();
    const runtimes = { resolve } as unknown as AgentRuntimeRegistry;
    const runner = new AgentRunner(
      new AgentDefinitionRegistry([definition]),
      runtimes,
    );

    await expect(
      runner.run({
        agentId: definition.id,
        runtime: 'future-runtime',
        input: 'hello',
      }),
    ).rejects.toThrow('does not match definition runtime');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('AgentRuntimeRegistry', () => {
  it('resolves Mastra through the explicit mapping', () => {
    const mastra = new MastraRuntime();
    const registry = new AgentRuntimeRegistry(mastra);

    expect(registry.resolve('mastra')).toBe(mastra);
  });

  it('fails loudly for an unregistered runtime', () => {
    const registry = new AgentRuntimeRegistry(new MastraRuntime());

    expect(() => registry.resolve('langgraph')).toThrow(
      'Agent runtime "langgraph" is not supported',
    );
  });
});
