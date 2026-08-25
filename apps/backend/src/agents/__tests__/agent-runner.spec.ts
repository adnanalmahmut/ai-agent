import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

import { AgentConfigurationError } from '../agent-configuration.error';
import { AgentDefinitionRegistry } from '../agent-definition.registry';
import { AgentOutputContractError } from '../agent-output-contract.error';
import type { AgentRuntime } from '../agent-runtime';
import type { AgentDefinition, AgentOutputContract } from '../agent.types';
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
 * The contract between the request and the answer, which no schema can state.
 *
 * A Zod output schema is handed the provider's answer and nothing else, so it
 * cannot know that a request for five results came back with four. That pair is
 * exactly where a billed agent goes wrong in a way every shape check passes, so
 * the definition carries an optional second gate and the runner runs it after
 * the parse and before the value is returned for durable storage.
 */
describe('the declared output contract', () => {
  const countingDefinition = {
    ...definition,
    id: 'counting-agent',
    input: z.object({ wanted: z.number() }),
    output: z.object({ items: z.array(z.string()) }).strict(),
    outputContract: ((input, output) => {
      const expected = (input as { wanted: number }).wanted;
      const received = (output as { items: string[] }).items.length;

      return received === expected
        ? null
        : { code: 'count_mismatch', expected, received };
    }) satisfies AgentOutputContract,
  } as const;

  const runnerReturning = (
    output: unknown,
    definitionOverride: AgentDefinition = countingDefinition,
  ) =>
    runnerFor([definitionOverride], {
      resolve: jest.fn<(name: string) => AgentRuntime>(() => ({
        name: 'mastra',
        run: () => Promise.resolve({ output: output as never }),
      })),
    } as unknown as AgentRuntimeRegistry);

  const runWanting = (
    runner: ReturnType<typeof runnerReturning>,
    wanted: number,
    agentId: string = countingDefinition.id,
  ) =>
    runner.run({
      agentId,
      agentVersion: 1,
      runtime: 'mastra',
      organizationId: 'org_1',
      input: { wanted },
    });

  it('refuses an answer that parses but breaks the contract', async () => {
    await expect(
      runWanting(runnerReturning({ items: ['a', 'b'] }), 3),
    ).rejects.toThrow(
      'Agent output does not satisfy its declared contract: count_mismatch (expected 3, received 2)',
    );
  });

  /**
   * The message is the runner's, assembled from the violation's code and its two
   * integers. Asserted because it is the containment claim: a contract cannot
   * put provider text into an `Error` even if it wants to, since the violation
   * type carries no string at all.
   */
  it('composes the message itself, from a code and two integers', async () => {
    const outputContract = jest.fn<AgentOutputContract>(() => ({
      code: 'count_mismatch',
      expected: 3,
      received: 0,
    }));

    const runner = runnerReturning(
      { items: [] },
      { ...countingDefinition, id: 'message-agent', outputContract },
    );

    await expect(runWanting(runner, 3, 'message-agent')).rejects.toThrow(
      /^Agent output does not satisfy its declared contract: count_mismatch \(expected 3, received 0\)$/,
    );
  });

  /**
   * "I could not check" is not "it is fine".
   *
   * A contract that recovers its types by re-parsing has a branch the runner's
   * own guarantees make unreachable — and the day a schema grows a transform
   * whose output no longer satisfies it, that branch is the whole promise
   * quietly switching itself off. It is a refusal, and a retryable one.
   */
  it('refuses an answer a contract could not verify', async () => {
    const runner = runnerReturning(
      { items: ['a', 'b', 'c'] },
      {
        ...countingDefinition,
        id: 'unverifiable-agent',
        outputContract: (() => ({
          code: 'unverifiable',
        })) satisfies AgentOutputContract,
      },
    );

    const attempt = runWanting(runner, 3, 'unverifiable-agent');

    await expect(attempt).rejects.toThrow(
      /^Agent output does not satisfy its declared contract: unverifiable$/,
    );
    await expect(attempt).rejects.not.toBeInstanceOf(AgentConfigurationError);
  });

  /**
   * A class of its own, and the one thing it is *not*.
   *
   * The class exists so the worker can name the failure in a log without
   * changing how it is retried — so both halves are asserted here, because
   * making it an `AgentConfigurationError` would be the natural-looking tidy-up
   * and would end the run on first sight.
   */
  it('carries its own class, which is not the deterministic one', async () => {
    const attempt = runWanting(runnerReturning({ items: [] }), 3);

    await expect(attempt).rejects.toBeInstanceOf(AgentOutputContractError);
    await expect(attempt).rejects.not.toBeInstanceOf(AgentConfigurationError);
    await expect(attempt).rejects.toMatchObject({
      violation: { code: 'count_mismatch', expected: 3, received: 0 },
    });
  });

  /**
   * The count is exact in both directions. A contract stated as a floor would
   * accept an answer that spends output tokens nobody asked for, and would let
   * a list overflow a screen sized for what was requested.
   */
  it('refuses an answer that overshoots the contract', async () => {
    await expect(
      runWanting(runnerReturning({ items: ['a', 'b', 'c', 'd'] }), 3),
    ).rejects.toThrow('count_mismatch (expected 3, received 4)');
  });

  it('stores an answer that satisfies it', async () => {
    await expect(
      runWanting(runnerReturning({ items: ['a', 'b', 'c'] }), 3),
    ).resolves.toEqual({ output: { items: ['a', 'b', 'c'] } });
  });

  /**
   * The classification, which is the part that costs money if it is wrong.
   *
   * A model that miscounted once may count correctly on the next attempt, so a
   * violation is an ordinary retryable failure. Making it an
   * `AgentConfigurationError` — the natural-looking tidy-up, since it is a
   * "contract" failure — would end the run on first sight and spend none of the
   * budget the failure is eligible for.
   */
  it('keeps its retry budget', async () => {
    const attempt = runWanting(runnerReturning({ items: [] }), 3);

    // Both halves. The negative alone is satisfied by any rejection that is not
    // that class — including a `TypeError` from an unrelated regression in the
    // runner — so it would pass while proving nothing.
    await expect(attempt).rejects.toThrow(
      'does not satisfy its declared contract',
    );
    await expect(attempt).rejects.not.toBeInstanceOf(AgentConfigurationError);
  });

  /**
   * The contract sees the *parsed* input, so a value the schema defaulted is
   * the value contracted against. Reading `run.input` instead would contract a
   * request that omitted the field against `undefined` and pass anything.
   */
  it('is given the defaulted input rather than the stored row', async () => {
    const seen: unknown[] = [];
    const defaulting = {
      ...countingDefinition,
      id: 'defaulting-agent',
      input: z.object({ wanted: z.number().default(3) }),
      outputContract: ((input, output) => {
        seen.push(input);

        const expected = (input as { wanted: number }).wanted;
        const received = (output as { items: string[] }).items.length;

        return received === expected
          ? null
          : { code: 'count_mismatch', expected, received };
      }) satisfies AgentOutputContract,
    } as const;

    const runner = runnerReturning({ items: ['a', 'b', 'c'] }, defaulting);

    await expect(
      runner.run({
        agentId: 'defaulting-agent',
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: 'org_1',
        input: {},
      }),
    ).resolves.toEqual({ output: { items: ['a', 'b', 'c'] } });

    expect(seen).toEqual([{ wanted: 3 }]);
  });

  /**
   * The contract never runs on unparsed data, so an implementation may rely on
   * its arguments. A malformed answer is the schema's refusal, not the
   * contract's, and running the contract on it would hand every implementation
   * a shape it did not agree to read.
   */
  it('is not consulted when the schema already refused the answer', async () => {
    const outputContract = jest.fn<AgentOutputContract>(() => null);
    const guarded = {
      ...countingDefinition,
      id: 'guarded-agent',
      outputContract,
    } as const;

    await expect(
      runnerReturning({ items: [42] }, guarded).run({
        agentId: 'guarded-agent',
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: 'org_1',
        input: { wanted: 1 },
      }),
    ).rejects.toThrow('does not satisfy its declared schema');

    expect(outputContract).not.toHaveBeenCalled();
  });

  /** A definition without one is unaffected: the schema is the whole contract. */
  it('is optional', async () => {
    const runner = runnerFor([definition], {
      resolve: jest.fn<(name: string) => AgentRuntime>(() => ({
        name: 'mastra',
        run: () => Promise.resolve({ output: 'done' }),
      })),
    } as unknown as AgentRuntimeRegistry);

    await expect(
      runner.run({
        agentId: definition.id,
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: 'org_1',
        input: 'hello',
      }),
    ).resolves.toEqual({ output: 'done' });
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
