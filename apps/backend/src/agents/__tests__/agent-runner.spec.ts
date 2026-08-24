import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

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
  input: z.union([z.string(), z.object({ question: z.string() })]),
  output: z.string(),
} as const;

/** The adapter resolves a credential per run; these tests never reach it. */
const stubRuntimeConfig = {
  secret: jest.fn<() => Promise<string>>(() =>
    Promise.resolve('unused-in-these-tests'),
  ),
} as never;

/** No policy, so the assembler is never consulted unless a test asks for one. */
const noContext = {
  assemble: jest.fn<() => Promise<never[]>>(() => Promise.resolve([])),
};

const runnerFor = (
  definitions: Parameters<
    typeof AgentDefinitionRegistry.prototype.resolve
  > extends never
    ? never
    : ConstructorParameters<typeof AgentDefinitionRegistry>[0],
  runtimes: AgentRuntimeRegistry,
  context: { assemble: (input: unknown) => Promise<unknown> } = noContext,
) =>
  new AgentRunner(
    new AgentDefinitionRegistry(definitions),
    runtimes,
    context as never,
  );

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
    const runner = runnerFor([definition], runtimes);

    await expect(
      runner.run({
        agentId: definition.id,
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: 'org_1',
        input: { question: 'hello' },
      }),
    ).resolves.toEqual({ output: 'done' });

    expect(resolve).toHaveBeenCalledWith('mastra');
    expect(run).toHaveBeenCalledWith({
      definition,
      input: { question: 'hello' },
      context: [],
    });
  });

  it('rejects a persisted runtime that differs from the definition', async () => {
    const resolve = jest.fn();
    const runtimes = { resolve } as unknown as AgentRuntimeRegistry;
    const runner = runnerFor([definition], runtimes);

    await expect(
      runner.run({
        agentId: definition.id,
        agentVersion: 1,
        runtime: 'future-runtime',
        organizationId: 'org_1',
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
    const runner = runnerFor([definition, definitionV2], runtimes);

    await runner.run({
      agentId: definition.id,
      agentVersion: 1,
      runtime: 'mastra',
      organizationId: 'org_1',
      input: 'hello',
    });

    expect(run).toHaveBeenCalledWith({
      definition,
      input: 'hello',
      context: [],
    });

    await runner.run({
      agentId: definition.id,
      agentVersion: 2,
      runtime: 'mastra',
      organizationId: 'org_1',
      input: 'hello',
    });

    expect(run).toHaveBeenLastCalledWith({
      definition: definitionV2,
      input: 'hello',
      context: [],
    });
  });

  it('fails loudly for a version that is not registered', async () => {
    const resolve = jest.fn();
    const runner = runnerFor([definition], {
      resolve,
    } as unknown as AgentRuntimeRegistry);

    await expect(
      runner.run({
        agentId: definition.id,
        agentVersion: 7,
        runtime: 'mastra',
        organizationId: 'org_1',
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
    const mastra = new MastraRuntime(stubRuntimeConfig);
    const registry = new AgentRuntimeRegistry(mastra);

    expect(registry.resolve('mastra')).toBe(mastra);
  });

  it('fails loudly for an unregistered runtime', () => {
    const registry = new AgentRuntimeRegistry(
      new MastraRuntime(stubRuntimeConfig),
    );

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
    const runner = runnerFor([definition], {
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
        organizationId: 'org_1',
        input: 'hello',
      }),
    ).rejects.toBeInstanceOf(AgentConfigurationError);
  });

  it('marks a persisted runtime disagreeing with the definition as a configuration failure', async () => {
    const runner = runnerFor([definition], {
      resolve: jest.fn(),
    } as unknown as AgentRuntimeRegistry);

    await expect(
      runner.run({
        agentId: definition.id,
        agentVersion: 1,
        runtime: 'future-runtime',
        organizationId: 'org_1',
        input: 'hello',
      }),
    ).rejects.toBeInstanceOf(AgentConfigurationError);
  });

  it('marks an unsupported runtime name as a configuration failure', () => {
    const registry = new AgentRuntimeRegistry(
      new MastraRuntime(stubRuntimeConfig),
    );

    expect(() => registry.resolve('langgraph')).toThrow(
      AgentConfigurationError,
    );
  });
});

/**
 * The pinned version decides the contract, not just the instructions.
 *
 * The tests above prove the pinned *definition object* reaches the runtime.
 * They say nothing about which schema the stored input was checked against,
 * and those are different claims: resolving the definition correctly and then
 * validating against `resolve(id)`-latest would pass every one of them while
 * admitting an input the accepted version never promised to handle.
 */
describe('the pinned version validates the input', () => {
  const strictV1 = {
    ...definition,
    id: 'schema-drift-agent',
    version: 1,
    input: z.string(),
  } as const;

  const widerV2 = {
    ...definition,
    id: 'schema-drift-agent',
    version: 2,
    input: z.object({ question: z.string() }),
  } as const;

  const runnerWithBoth = () => {
    const run = jest
      .fn<(request: unknown) => Promise<{ output: string }>>()
      .mockResolvedValue({ output: 'done' });

    const runner = runnerFor([strictV1, widerV2], {
      resolve: jest.fn<(name: string) => AgentRuntime>(() => ({
        name: 'mastra',
        run: (request) => run(request),
      })),
    } as unknown as AgentRuntimeRegistry);

    return { runner, run };
  };

  it('refuses input that only a newer version would accept', async () => {
    const { runner, run } = runnerWithBoth();

    await expect(
      runner.run({
        agentId: 'schema-drift-agent',
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: 'org_1',
        input: { question: 'hello' },
      }),
    ).rejects.toBeInstanceOf(AgentConfigurationError);

    // Never reached the provider: a stored input that does not satisfy the
    // version it was accepted against cannot be made to by paying for a call.
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts the same input under the version that declares it', async () => {
    const { runner, run } = runnerWithBoth();

    await runner.run({
      agentId: 'schema-drift-agent',
      agentVersion: 2,
      runtime: 'mastra',
      organizationId: 'org_1',
      input: { question: 'hello' },
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * Deterministic, so it must not be retried. A stored input is a fixed value
   * and the schema it is checked against is pinned; the third attempt reaches
   * the same verdict as the first, three backoffs later.
   */
  it('classifies unsatisfied input as a configuration failure', async () => {
    const { runner } = runnerWithBoth();

    await expect(
      runner.run({
        agentId: 'schema-drift-agent',
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: 'org_1',
        input: 42,
      }),
    ).rejects.toBeInstanceOf(AgentConfigurationError);
  });
});

/**
 * The other half of the classification, which is the half that costs money if
 * it is wrong in either direction.
 *
 * A model that answered in the wrong shape once may answer correctly on the
 * next attempt, so this failure keeps its retry budget — and the natural
 * "tidy-up" of making every throw in this file an `AgentConfigurationError`
 * would turn one bad response into an immediately final run.
 */
describe('a malformed provider answer', () => {
  const runnerReturning = (output: unknown) => {
    const definitionWithOutput = {
      ...definition,
      output: z
        .object({
          answer: z.string(),
          /** A default, so the parsed value is observably not the payload. */
          sources: z.array(z.string()).default([]),
        })
        .strict(),
    } as const;

    return runnerFor([definitionWithOutput], {
      resolve: jest.fn<(name: string) => AgentRuntime>(() => ({
        name: 'mastra',
        run: () => Promise.resolve({ output: output as never }),
      })),
    } as unknown as AgentRuntimeRegistry);
  };

  const runOnce = (runner: ReturnType<typeof runnerReturning>) =>
    runner.run({
      agentId: definition.id,
      agentVersion: 1,
      runtime: 'mastra',
      organizationId: 'org_1',
      input: 'hello',
    });

  it('is rejected rather than stored', async () => {
    await expect(
      runOnce(runnerReturning({ reply: 'wrong key' })),
    ).rejects.toThrow('does not satisfy its declared schema');
  });

  it('keeps its retry budget', async () => {
    await expect(
      runOnce(runnerReturning({ reply: 'wrong key' })),
    ).rejects.not.toBeInstanceOf(AgentConfigurationError);
  });

  /**
   * What is stored is the schema's product, not the provider's payload.
   *
   * Returning `result.output` directly passes every other test in this block —
   * the parse still happens, so malformed answers are still refused — while
   * every consumer of `AgentRun.output` loses the guarantees the schema was
   * declared for. Here that is a defaulted field arriving absent.
   */
  it('returns the parsed value, not the provider payload', async () => {
    await expect(
      runOnce(runnerReturning({ answer: 'hello' })),
    ).resolves.toEqual({ output: { answer: 'hello', sources: [] } });
  });
});

/**
 * What the retrieval is made similar to, and on whose behalf.
 *
 * Nothing else asserts the arguments to `assemble`, so the organization and
 * the policy could both be dropped — and the query could be `JSON.stringify`
 * of the whole envelope, which embeds field names and punctuation and moves
 * the vector away from the material the caller is asking about. All three fail
 * silently: retrieval still returns *something*.
 */
describe('the query handed to retrieval', () => {
  const contextual = {
    ...definition,
    input: z.object({
      topic: z.string(),
      audience: z.string(),
      count: z.number(),
    }),
    contextPolicy: {
      spaceSlugs: ['brand.voice'],
      maxChunks: 3,
      maxCharacters: 500,
    },
  } as const;

  it('is the input string leaves, on behalf of the run organization', async () => {
    const assemble = jest.fn<(input: unknown) => Promise<never[]>>(() =>
      Promise.resolve([]),
    );

    const runner = runnerFor(
      [contextual],
      {
        resolve: jest.fn<(name: string) => AgentRuntime>(() => ({
          name: 'mastra',
          run: () => Promise.resolve({ output: 'done' }),
        })),
      } as unknown as AgentRuntimeRegistry,
      { assemble },
    );

    await runner.run({
      agentId: definition.id,
      agentVersion: 1,
      runtime: 'mastra',
      organizationId: 'org_9',
      input: { topic: 'Kettles', audience: 'Home cooks', count: 5 },
    });

    expect(assemble).toHaveBeenCalledWith({
      organizationId: 'org_9',
      policy: contextual.contextPolicy,
      query: 'Kettles\nHome cooks',
    });
  });
});
