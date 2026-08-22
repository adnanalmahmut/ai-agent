import { describe, expect, it, jest } from '@jest/globals';

import { AgentDefinitionRegistry } from '../agent-definition.registry';
import type { AgentRuntime } from '../agent-runtime';
import { AgentRuntimeRegistry } from '../agent-runtime.registry';
import { AgentRunner } from '../agent-runner.service';
import { MastraRuntime } from '../runtime/mastra/mastra.runtime';

const definition = {
  id: 'test-support-agent',
  version: 1,
  runtime: 'mastra',
  instructions: 'Answer test requests.',
  model: 'test/provider-model',
} as const;

const definitionV2 = {
  ...definition,
  version: 2,
  instructions: 'Answer test requests differently.',
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
        agentVersion: 1,
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
        agentVersion: 1,
        runtime: 'future-runtime',
        input: 'hello',
      }),
    ).rejects.toThrow('does not match definition runtime');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('executes the pinned version even after a newer one is registered', async () => {
    const run = jest
      .fn<(request: unknown) => Promise<{ output: string }>>()
      .mockResolvedValue({ output: 'done' });
    const runtime: AgentRuntime = {
      name: 'mastra',
      run: (request) => run(request),
    };
    const runtimes = {
      resolve: jest.fn<(name: string) => AgentRuntime>(() => runtime),
    } as unknown as AgentRuntimeRegistry;

    // v2 exists in the registry; a run accepted against v1 must not drift onto
    // it. This is the rolling-deployment case the pinned pair exists for.
    const runner = new AgentRunner(
      new AgentDefinitionRegistry([definition, definitionV2]),
      runtimes,
    );

    await runner.run({
      agentId: definition.id,
      agentVersion: 1,
      runtime: 'mastra',
      input: 'hello',
    });

    expect(run).toHaveBeenCalledWith({ definition, input: 'hello' });

    await runner.run({
      agentId: definition.id,
      agentVersion: 2,
      runtime: 'mastra',
      input: 'hello',
    });

    expect(run).toHaveBeenLastCalledWith({
      definition: definitionV2,
      input: 'hello',
    });
  });

  it('fails loudly for a version that is not registered', async () => {
    const resolve = jest.fn();
    const runner = new AgentRunner(new AgentDefinitionRegistry([definition]), {
      resolve,
    } as unknown as AgentRuntimeRegistry);

    await expect(
      runner.run({
        agentId: definition.id,
        agentVersion: 7,
        runtime: 'mastra',
        input: 'hello',
      }),
    ).rejects.toThrow(
      'Agent definition "test-support-agent@7" is not registered',
    );
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('AgentDefinitionRegistry', () => {
  it('rejects an exact duplicate (id, version) pair at composition', () => {
    expect(
      () => new AgentDefinitionRegistry([definition, { ...definition }]),
    ).toThrow('Duplicate agent definition "test-support-agent@1"');
  });

  it('accepts one id registered at distinct versions', () => {
    const registry = new AgentDefinitionRegistry([definition, definitionV2]);

    expect(registry.resolve(definition.id, 1)).toBe(definition);
    expect(registry.resolve(definition.id, 2)).toBe(definitionV2);
  });

  it('never falls back to another version of the same id', () => {
    const registry = new AgentDefinitionRegistry([definitionV2]);

    expect(() => registry.resolve(definition.id, 1)).toThrow(
      'Agent definition "test-support-agent@1" is not registered',
    );
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
