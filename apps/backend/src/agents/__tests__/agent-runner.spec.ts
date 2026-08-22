import { describe, expect, it, jest } from '@jest/globals';

import { AgentConfigurationError } from '../agent-configuration.error';
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

/**
 * The class, not the wording, at every deterministic throw site.
 *
 * A proven hole rather than a hypothetical one: reverting all three sites from
 * `AgentConfigurationError` to a plain `new Error(...)` left the entire unit
 * and e2e suites green, because every assertion above matches only on message
 * text — which both classes carry identically.
 *
 * The regression that hides behind that is not cosmetic. `AgentExecutionHandler`
 * branches on `isAgentConfigurationError`, and identity is the only thing it
 * reads. A plain `Error` therefore stops being final on first sight and
 * silently regains the full retry budget with exponential backoff for a failure
 * whose third attempt resolves exactly the same registry as its first — while
 * the run sits `RUNNING` between the attempts and nobody is told any sooner.
 */
describe('deterministic configuration failures carry their own class', () => {
  it('marks an unregistered (id, version) pair as a configuration failure', async () => {
    const registry = new AgentDefinitionRegistry([definition]);
    const resolve = jest.fn();
    const runner = new AgentRunner(registry, {
      resolve,
    } as unknown as AgentRuntimeRegistry);

    expect(() => registry.resolve(definition.id, 7)).toThrow(
      AgentConfigurationError,
    );

    // Asserted through the runner too: this is the path the worker takes, and
    // it is the worker's classification that the class decides.
    await expect(
      runner.run({
        agentId: definition.id,
        agentVersion: 7,
        runtime: 'mastra',
        input: 'hello',
      }),
    ).rejects.toBeInstanceOf(AgentConfigurationError);
  });

  it('marks a persisted runtime disagreeing with the definition as a configuration failure', async () => {
    const runner = new AgentRunner(new AgentDefinitionRegistry([definition]), {
      resolve: jest.fn(),
    } as unknown as AgentRuntimeRegistry);

    await expect(
      runner.run({
        agentId: definition.id,
        agentVersion: 1,
        runtime: 'future-runtime',
        input: 'hello',
      }),
    ).rejects.toBeInstanceOf(AgentConfigurationError);
  });

  it('marks an unsupported runtime name as a configuration failure', () => {
    const registry = new AgentRuntimeRegistry(new MastraRuntime());

    expect(() => registry.resolve('langgraph')).toThrow(
      AgentConfigurationError,
    );
  });
});
