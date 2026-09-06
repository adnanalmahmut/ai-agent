import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

import { MODEL_IDS } from '../../../../src/ai/models/model-catalog';
import { AgentConfigurationError } from '../../../../src/ai/agents/agent-configuration.error';
import { AgentDefinitionRegistry } from '../../../../src/ai/agents/agent-definition.registry';
import { AgentOutputContractError } from '../../../../src/ai/execution/agent-output-contract.error';
import { AgentRunner } from '../../../../src/ai/execution/agent-runner.service';
import type { AgentRuntime } from '../../../../src/ai/execution/agent-runtime';
import { AgentRuntimeRegistry } from '../../../../src/ai/execution/agent-runtime.registry';
import type {
  AgentDefinition,
  AgentOutputContract,
} from '../../../../src/ai/agents/agent.types';
import { MCP_SESSION_RUNTIME } from '../../../../src/ai/agents/agent.types';
import { MastraRuntime } from '../../../../src/ai/infrastructure/runtimes/mastra/mastra.runtime';

const definition = {
  id: 'test-support-agent',
  version: 1,
  runtime: 'mastra',
  instructions: 'Answer test requests.',
  model: MODEL_IDS.openAiGpt4oMini,
  modelPolicy: {
    id: 'test-support-agent.model-policy.1',
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  input: z.union([z.string(), z.object({ question: z.string() })]),
  output: z.string(),
} as const;

const stubRuntimeConfig = {
  secret: jest.fn<() => Promise<string>>(() =>
    Promise.resolve('unused-in-these-tests'),
  ),
} as never;

const noContext = {
  assemble: jest.fn<() => Promise<never[]>>(() => Promise.resolve([])),
};

const noTools = { authorize: () => [] };

type OptionalRunPin =
  | 'id'
  | 'attemptCount'
  | 'organizationAgentVersionId'
  | 'modelPolicyId'
  | 'modelId'
  | 'modelPricingRevisionId'
  | 'createdAt';
type TestRun = Omit<Parameters<AgentRunner['run']>[0], OptionalRunPin> &
  Partial<Pick<Parameters<AgentRunner['run']>[0], OptionalRunPin>>;
type TestRunner = Omit<AgentRunner, 'run'> & {
  run(run: TestRun): ReturnType<AgentRunner['run']>;
};

const runnerFor = (
  definitions: Parameters<
    typeof AgentDefinitionRegistry.prototype.resolve
  > extends never
    ? never
    : ConstructorParameters<typeof AgentDefinitionRegistry>[0],
  runtimes: AgentRuntimeRegistry,
  context: { assemble: (input: unknown) => Promise<unknown> } = noContext,
) => {
  const runner = new AgentRunner(
    new AgentDefinitionRegistry(definitions),
    runtimes,
    context as never,
    { pinnedVersionFor: () => Promise.resolve(null) } as never,
    noTools as never,
  );

  return {
    run: (run: TestRun) =>
      runner.run({
        ...run,
        id: run.id ?? 'run_1',
        attemptCount: run.attemptCount ?? 1,
        organizationAgentVersionId: run.organizationAgentVersionId ?? null,
        modelPolicyId: run.modelPolicyId ?? null,
        modelId: run.modelId ?? null,
        modelPricingRevisionId: run.modelPricingRevisionId ?? null,
        createdAt: run.createdAt ?? new Date('2026-08-27T00:00:00.000Z'),
      }),
  } as TestRunner;
};

const definitionV2 = {
  ...definition,
  version: 2,
  modelPolicy: {
    id: 'test-support-agent.model-policy.2',
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
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
      model: MODEL_IDS.openAiGpt4oMini,
      configuration: {},
      input: { question: 'hello' },
      context: [],
      tools: [],
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

  it('refuses to execute an MCP session run before resolving any runtime', async () => {
    const resolve = jest.fn();
    const runtimes = { resolve } as unknown as AgentRuntimeRegistry;
    const runner = runnerFor([definition], runtimes);

    await expect(
      runner.run({
        agentId: definition.id,
        agentVersion: 1,
        runtime: MCP_SESSION_RUNTIME,
        organizationId: 'org_1',
        input: 'hello',
      }),
    ).rejects.toThrow(AgentConfigurationError);

    await expect(
      runner.run({
        agentId: definition.id,
        agentVersion: 1,
        runtime: MCP_SESSION_RUNTIME,
        organizationId: 'org_1',
        input: 'hello',
      }),
    ).rejects.toThrow(
      'AgentRun runtime "mcp" does not match definition runtime "mastra"',
    );

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
      model: MODEL_IDS.openAiGpt4oMini,
      configuration: {},
      input: 'hello',
      context: [],
      tools: [],
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
      model: MODEL_IDS.openAiGpt4oMini,
      configuration: {},
      input: 'hello',
      context: [],
      tools: [],
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

describe('AgentRunner model pinning', () => {
  const pricingRevisionId = 'openai.gpt-4o-mini.standard.2024-10-01';
  const pinnedRun = (
    overrides: Partial<Parameters<AgentRunner['run']>[0]> = {},
  ): Parameters<AgentRunner['run']>[0] => ({
    id: 'run_1',
    attemptCount: 1,
    agentId: definition.id,
    agentVersion: definition.version,
    runtime: definition.runtime,
    organizationId: 'org_1',
    organizationAgentVersionId: null,
    modelPolicyId: definition.modelPolicy.id,
    modelId: MODEL_IDS.openAiGpt4oMini,
    modelPricingRevisionId: pricingRevisionId,
    createdAt: new Date('2026-08-27T00:00:00.000Z'),
    input: 'hello',
    ...overrides,
  });

  const setup = () => {
    const runtimeRun = jest
      .fn<(request: unknown) => Promise<{ output: string }>>()
      .mockResolvedValue({ output: 'done' });
    const runner = runnerFor([definition], {
      resolve: () => ({ name: 'mastra', run: runtimeRun }),
    } as never);
    return { runner, runtimeRun };
  };

  it('passes the accepted stable model identity to the runtime', async () => {
    const { runner, runtimeRun } = setup();

    await expect(runner.run(pinnedRun())).resolves.toEqual({ output: 'done' });
    expect(runtimeRun).toHaveBeenCalledWith(
      expect.objectContaining({ model: MODEL_IDS.openAiGpt4oMini }),
    );
  });

  it('refuses a partially populated durable model pin', async () => {
    const { runner, runtimeRun } = setup();

    await expect(
      runner.run(pinnedRun({ modelPricingRevisionId: null })),
    ).rejects.toBeInstanceOf(AgentConfigurationError);
    expect(runtimeRun).not.toHaveBeenCalled();
  });

  it('refuses a policy identity that differs from the pinned definition', async () => {
    const { runner, runtimeRun } = setup();

    await expect(
      runner.run(pinnedRun({ modelPolicyId: 'tampered-policy' })),
    ).rejects.toBeInstanceOf(AgentConfigurationError);
    expect(runtimeRun).not.toHaveBeenCalled();
  });

  it('refuses a pricing revision that was not effective at acceptance', async () => {
    const { runner, runtimeRun } = setup();

    await expect(
      runner.run(pinnedRun({ modelPricingRevisionId: 'tampered-pricing' })),
    ).rejects.toBeInstanceOf(AgentConfigurationError);
    expect(runtimeRun).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', 'unknown.model'],
    ['capability-incompatible', MODEL_IDS.openAiTextEmbedding3Small],
  ])(
    'refuses a %s pinned model before the runtime call',
    async (_case, modelId) => {
      const { runner, runtimeRun } = setup();

      await expect(
        runner.run(pinnedRun({ modelId: modelId as never })),
      ).rejects.toBeInstanceOf(AgentConfigurationError);
      expect(runtimeRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    { modelPolicyId: null },
    { modelId: null },
    { modelPricingRevisionId: null },
  ])('refuses partial durable model pin %#', async (partial) => {
    const { runner, runtimeRun } = setup();

    await expect(runner.run(pinnedRun(partial))).rejects.toBeInstanceOf(
      AgentConfigurationError,
    );
    expect(runtimeRun).not.toHaveBeenCalled();
  });
});

describe('AgentRunner organization configuration', () => {
  const configuredDefinition = {
    ...definition,
    id: 'configured-agent',
    organizationConfiguration: {
      schema: z.object({ tone: z.enum(['plain', 'warm']) }).strict(),
      defaultValue: { tone: 'plain' as const },
    },
  } as const;

  const configuredRunner = (stored: unknown) => {
    const runtimeRun = jest
      .fn<(request: unknown) => Promise<{ output: string }>>()
      .mockResolvedValue({ output: 'done' });
    const pinnedVersionFor = jest
      .fn<(run: unknown) => Promise<unknown>>()
      .mockResolvedValue(
        stored === null ? null : { configuration: stored, toolGrants: [] },
      );
    const runtime: AgentRuntime = {
      name: 'mastra',
      run: (request) => runtimeRun(request),
    };
    const runner = new AgentRunner(
      new AgentDefinitionRegistry([configuredDefinition]),
      { resolve: () => runtime } as unknown as AgentRuntimeRegistry,
      noContext,
      { pinnedVersionFor } as never,
      noTools as never,
    );

    return { runner, runtimeRun, pinnedVersionFor };
  };

  const run = (organizationAgentVersionId: string | null) => ({
    id: 'run_1',
    attemptCount: 1,
    agentId: configuredDefinition.id,
    agentVersion: 1,
    runtime: 'mastra',
    organizationId: 'org_1',
    organizationAgentVersionId,
    modelPolicyId: null,
    modelId: null,
    modelPricingRevisionId: null,
    createdAt: new Date('2026-08-27T00:00:00.000Z'),
    input: 'hello',
  });

  it('reloads and passes the parsed pinned configuration', async () => {
    const { runner, runtimeRun, pinnedVersionFor } = configuredRunner({
      tone: 'warm',
    });

    await expect(runner.run(run('version_1'))).resolves.toEqual({
      output: 'done',
    });
    expect(pinnedVersionFor).toHaveBeenCalledWith(run('version_1'));
    expect(runtimeRun).toHaveBeenCalledWith(
      expect.objectContaining({ configuration: { tone: 'warm' } }),
    );
  });

  it('refuses invalid pinned configuration before calling the runtime', async () => {
    const { runner, runtimeRun } = configuredRunner({ tone: 'untrusted' });

    await expect(runner.run(run('version_1'))).rejects.toBeInstanceOf(
      AgentConfigurationError,
    );
    expect(runtimeRun).not.toHaveBeenCalled();
  });

  it('uses the definition-owned default for a legacy null-reference run', async () => {
    const { runner, runtimeRun } = configuredRunner(null);

    await expect(runner.run(run(null))).resolves.toEqual({ output: 'done' });
    expect(runtimeRun).toHaveBeenCalledWith(
      expect.objectContaining({ configuration: { tone: 'plain' } }),
    );
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

    expect(registry.resolve(definition.id, 1)).toMatchObject(definition);
    expect(registry.resolve(definition.id, 2)).toMatchObject(definitionV2);
  });

  it('rejects duplicate policy identities across definition revisions', () => {
    expect(
      () =>
        new AgentDefinitionRegistry([
          definition,
          { ...definitionV2, modelPolicy: definition.modelPolicy },
        ]),
    ).toThrow('Duplicate agent model policy');
  });

  it('rejects a policy that excludes its default model', () => {
    expect(
      () =>
        new AgentDefinitionRegistry([
          {
            ...definition,
            modelPolicy: {
              ...definition.modelPolicy,
              allowedModelIds: [MODEL_IDS.openAiTextEmbedding3Small] as never,
            },
          },
        ]),
    ).toThrow('does not allow its default model');
  });

  it.each(['', ' whitespace '])('rejects invalid policy identity %j', (id) => {
    expect(
      () =>
        new AgentDefinitionRegistry([
          { ...definition, modelPolicy: { ...definition.modelPolicy, id } },
        ]),
    ).toThrow('invalid model policy identity');
  });

  it('rejects duplicate allowed model identities', () => {
    expect(
      () =>
        new AgentDefinitionRegistry([
          {
            ...definition,
            modelPolicy: {
              ...definition.modelPolicy,
              allowedModelIds: [definition.model, definition.model],
            },
          },
        ]),
    ).toThrow('contains duplicate models');
  });

  it('defensively freezes the registered policy and its allowed set', () => {
    const sourceAllowed = [MODEL_IDS.openAiGpt4oMini];
    const source = {
      ...definition,
      modelPolicy: {
        id: 'mutable-source.model-policy.1',
        allowedModelIds: sourceAllowed,
      },
    } satisfies AgentDefinition;
    const registry = new AgentDefinitionRegistry([source]);

    sourceAllowed.push(MODEL_IDS.openAiTextEmbedding3Small as never);
    source.modelPolicy.id = 'mutated';

    const stored = registry.resolve(source.id, source.version);
    expect(stored.modelPolicy).toEqual({
      id: 'mutable-source.model-policy.1',
      allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
    });
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.modelPolicy)).toBe(true);
    expect(Object.isFrozen(stored.modelPolicy.allowedModelIds)).toBe(true);
  });

  it('rejects a catalog model without agent-generation capability', () => {
    expect(
      () =>
        new AgentDefinitionRegistry([
          {
            ...definition,
            modelPolicy: {
              ...definition.modelPolicy,
              allowedModelIds: [
                MODEL_IDS.openAiGpt4oMini,
                MODEL_IDS.openAiTextEmbedding3Small,
              ] as never,
            },
          },
        ]),
    ).toThrow('unavailable for agent execution');
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

describe('the pinned version validates the input', () => {
  const strictV1 = {
    ...definition,
    id: 'schema-drift-agent',
    version: 1,
    modelPolicy: {
      id: 'schema-drift-agent.model-policy.1',
      allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
    },
    input: z.string(),
  } as const;

  const widerV2 = {
    ...definition,
    id: 'schema-drift-agent',
    version: 2,
    modelPolicy: {
      id: 'schema-drift-agent.model-policy.2',
      allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
    },
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

describe('a malformed provider answer', () => {
  const runnerReturning = (output: unknown) => {
    const definitionWithOutput = {
      ...definition,
      output: z
        .object({
          answer: z.string(),
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

  it('returns the parsed value, not the provider payload', async () => {
    await expect(
      runOnce(runnerReturning({ answer: 'hello' })),
    ).resolves.toEqual({ output: { answer: 'hello', sources: [] } });
  });
});

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

  it('carries its own class, which is not the deterministic one', async () => {
    const attempt = runWanting(runnerReturning({ items: [] }), 3);

    await expect(attempt).rejects.toBeInstanceOf(AgentOutputContractError);
    await expect(attempt).rejects.not.toBeInstanceOf(AgentConfigurationError);
    await expect(attempt).rejects.toMatchObject({
      violation: { code: 'count_mismatch', expected: 3, received: 0 },
    });
  });

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

  it('keeps its retry budget', async () => {
    const attempt = runWanting(runnerReturning({ items: [] }), 3);

    await expect(attempt).rejects.toThrow(
      'does not satisfy its declared contract',
    );
    await expect(attempt).rejects.not.toBeInstanceOf(AgentConfigurationError);
  });

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
