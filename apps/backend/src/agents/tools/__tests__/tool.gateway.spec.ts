import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

import { isAgentConfigurationError } from '../../agent-configuration.error';
import type { AgentDefinition, AgentValue } from '../../agent.types';
import { MODEL_IDS } from '../../../model-catalog/model-catalog';
import { ToolExecutionFailure, ToolGateway } from '../tool.gateway';
import { ToolRegistry } from '../tool.registry';
import type {
  ToolDefinition,
  ToolImplementation,
  ToolRef,
} from '../tool.types';

const REF: ToolRef = 'knowledge.search@1';

const toolDefinition = (
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition => ({
  id: 'knowledge.search',
  version: 1,
  runtimeName: 'knowledge_search_v1',
  description: 'Search knowledge.',
  input: z.object({ query: z.string().min(1) }).strict(),
  output: z.object({ passages: z.array(z.string()) }).strict(),
  risk: 'read_only',
  ...overrides,
});

const agentDefinition = (
  maxToolGrants?: readonly ToolRef[],
): AgentDefinition => ({
  id: 'test-agent',
  version: 1,
  runtime: 'mastra',
  instructions: 'Answer.',
  model: MODEL_IDS.openAiGpt4oMini,
  modelPolicy: {
    id: 'test-agent.model-policy.1',
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  input: z.unknown(),
  output: z.unknown(),
  ...(maxToolGrants ? { maxToolGrants } : {}),
});

const executions = () => ({
  start: jest.fn<(input: unknown) => Promise<string>>(() =>
    Promise.resolve('execution-1'),
  ),
  succeed: jest.fn<(...args: unknown[]) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  fail: jest.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
});

const gatewayWith = (
  execute: ToolImplementation['execute'],
  definition: ToolDefinition = toolDefinition(),
) => {
  const durable = executions();
  const gateway = new ToolGateway(
    new ToolRegistry([definition]),
    durable as never,
    [{ ref: REF, execute }],
  );

  return { gateway, durable };
};

const authorizeOne = (
  gateway: ToolGateway,
  grants: readonly string[] = [REF],
) =>
  gateway.authorize({
    definition: agentDefinition([REF]),
    organizationId: 'org_1',
    agentRunId: 'run_1',
    agentRunAttempt: 2,
    grants,
  });

describe('ToolGateway composition', () => {
  it('refuses an implementation for a tool that is not registered', () => {
    expect(
      () =>
        new ToolGateway(
          new ToolRegistry([toolDefinition()]),
          executions() as never,
          [
            {
              ref: 'invented@1' as ToolRef,
              execute: () => Promise.resolve({}),
            },
          ],
        ),
    ).toThrow('is not registered');
  });

  it('refuses a registered tool with no implementation', () => {
    expect(
      () =>
        new ToolGateway(
          new ToolRegistry([toolDefinition()]),
          executions() as never,
          [],
        ),
    ).toThrow('has no registered implementation');
  });

  it('refuses two implementations of one tool', () => {
    expect(
      () =>
        new ToolGateway(
          new ToolRegistry([toolDefinition()]),
          executions() as never,
          [
            { ref: REF, execute: () => Promise.resolve({}) },
            { ref: REF, execute: () => Promise.resolve({}) },
          ],
        ),
    ).toThrow('Duplicate tool implementation');
  });
});

describe('ToolGateway authorization', () => {
  it('exposes only the granted tools, under their audited runtime name', () => {
    const { gateway } = gatewayWith(() => Promise.resolve({ passages: [] }));

    const exposed = authorizeOne(gateway);

    expect(exposed).toHaveLength(1);
    expect(exposed[0]?.name).toBe('knowledge_search_v1');
    expect(exposed[0]?.description).toBe('Search knowledge.');
  });

  it('exposes nothing when the organization selected nothing', () => {
    const { gateway } = gatewayWith(() => Promise.resolve({ passages: [] }));

    expect(authorizeOne(gateway, [])).toEqual([]);
  });

  it('exposes nothing when the definition permits nothing', () => {
    const { gateway } = gatewayWith(() => Promise.resolve({ passages: [] }));

    expect(
      gateway.authorize({
        definition: agentDefinition(),
        organizationId: 'org_1',
        agentRunId: 'run_1',
        agentRunAttempt: 1,
        grants: [],
      }),
    ).toEqual([]);
  });

  /**
   * The escalation case. A stored grant outside the pinned definition's
   * maximum is refused rather than intersected away: two durable facts
   * disagree, and silently honouring the narrower one hides that.
   */
  it('refuses a stored grant outside the definition maximum', () => {
    const { gateway } = gatewayWith(() => Promise.resolve({ passages: [] }));

    let caught: unknown;
    try {
      gateway.authorize({
        definition: agentDefinition(),
        organizationId: 'org_1',
        agentRunId: 'run_1',
        agentRunAttempt: 1,
        grants: [REF],
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain(
      'outside its definition maximum',
    );
    // Deterministic, so it must not spend the run's retry budget.
    expect(isAgentConfigurationError(caught)).toBe(true);
  });

  it('refuses a stored grant naming a tool that does not exist', () => {
    const { gateway } = gatewayWith(() => Promise.resolve({ passages: [] }));

    expect(() => authorizeOne(gateway, ['invented@1'])).toThrow(
      'grants unknown tool "invented@1"',
    );
  });

  it('refuses to expose a tool that is not read-only', () => {
    const { gateway } = gatewayWith(
      () => Promise.resolve({ passages: [] }),
      toolDefinition({ risk: 'side_effect' }),
    );

    expect(() => authorizeOne(gateway)).toThrow('is not read-only');
  });
});

describe('ToolGateway execution', () => {
  let durable: ReturnType<typeof executions>;

  const run = async (
    execute: ToolImplementation['execute'],
    input: AgentValue = { query: 'refunds' },
  ) => {
    const built = gatewayWith(execute);
    durable = built.durable;
    const [tool] = authorizeOne(built.gateway);

    return tool.execute(input);
  };

  beforeEach(() => {
    durable = executions();
  });

  it('records the exact identity, parsed input, and result', async () => {
    await expect(
      run(() => Promise.resolve({ passages: ['a'] })),
    ).resolves.toEqual({ passages: ['a'] });

    expect(durable.start).toHaveBeenCalledWith({
      organizationId: 'org_1',
      agentRunId: 'run_1',
      agentRunAttempt: 2,
      // The durable identity, never the model-facing runtime name.
      toolId: 'knowledge.search',
      toolVersion: 1,
      input: { query: 'refunds' },
    });
    expect(durable.succeed).toHaveBeenCalledWith('execution-1', {
      passages: ['a'],
    });
    expect(durable.fail).not.toHaveBeenCalled();
  });

  /**
   * A refused call is not a failed execution. Recording one would make a
   * denial indistinguishable from an attempt in history.
   */
  it('writes nothing durable when the input is refused', async () => {
    await expect(
      run(() => Promise.resolve({ passages: [] }), { query: '' }),
    ).rejects.toBeInstanceOf(ToolExecutionFailure);

    expect(durable.start).not.toHaveBeenCalled();
    expect(durable.fail).not.toHaveBeenCalled();
  });

  it('refuses input carrying fields the schema does not declare', async () => {
    await expect(
      run(() => Promise.resolve({ passages: [] }), {
        query: 'refunds',
        organizationId: 'org_2',
      }),
    ).rejects.toBeInstanceOf(ToolExecutionFailure);

    expect(durable.start).not.toHaveBeenCalled();
  });

  it('never lets an implementation error reach the record or the caller', async () => {
    const secret = 'postgres://user:hunter2@db/app';

    await expect(run(() => Promise.reject(new Error(secret)))).rejects.toThrow(
      'Tool "knowledge.search@1" failed',
    );

    expect(durable.fail).toHaveBeenCalledWith(
      'execution-1',
      'implementation_error',
    );
    expect(JSON.stringify(durable.fail.mock.calls)).not.toContain('hunter2');
    expect(durable.succeed).not.toHaveBeenCalled();
  });

  it('fails closed when an implementation returns an unusable shape', async () => {
    await expect(
      run(() => Promise.resolve({ passages: 'not-an-array' })),
    ).rejects.toThrow('returned a result its schema refuses');

    expect(durable.fail).toHaveBeenCalledWith('execution-1', 'output_rejected');
    expect(durable.succeed).not.toHaveBeenCalled();
  });

  it('gives the implementation context it could not have been told', async () => {
    const seen = jest.fn();
    await run((input, context) => {
      seen(context);
      return Promise.resolve({ passages: [] });
    });

    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        agentRunId: 'run_1',
        agentRunAttempt: 2,
      }),
    );
  });
});
