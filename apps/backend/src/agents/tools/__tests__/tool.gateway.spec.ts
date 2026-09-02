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

  /**
   * Refused when the build is composed, not when a run first reaches it.
   *
   * Deferring it to authorize time would accept the definition and the
   * organization's selection, then fail every run of that agent — including
   * runs where the model would never have called the tool.
   */
  it('refuses to compose a build containing a tool it cannot execute', () => {
    expect(() =>
      gatewayWith(
        () => Promise.resolve({ passages: [] }),
        toolDefinition({ risk: 'side_effect' }),
      ),
    ).toThrow('is not read-only and this build cannot execute one');
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
    expect(durable.succeed).toHaveBeenCalledWith('execution-1', 'org_1', {
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
      'Tool "knowledge_search_v1" failed',
    );

    expect(durable.fail).toHaveBeenCalledWith(
      'execution-1',
      'org_1',
      'implementation_error',
    );
    expect(JSON.stringify(durable.fail.mock.calls)).not.toContain('hunter2');
    expect(durable.succeed).not.toHaveBeenCalled();
  });

  it('fails closed when an implementation returns an unusable shape', async () => {
    await expect(
      run(() => Promise.resolve({ passages: 'not-an-array' })),
    ).rejects.toThrow('returned a result its schema refuses');

    expect(durable.fail).toHaveBeenCalledWith(
      'execution-1',
      'org_1',
      'output_rejected',
    );
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

/**
 * Nothing but the application's own sentence may leave a tool call.
 *
 * Mastra does not let a tool error end the run: it serializes the error's
 * name, message, stack and own properties into the transcript and sends that
 * to the provider on the next step. Everything raised in here is therefore
 * outbound text, not a failure signal.
 */
describe('ToolGateway containment', () => {
  const runWithDurable = async (
    durable: Record<string, unknown>,
    execute: ToolImplementation['execute'] = () =>
      Promise.resolve({ passages: [] }),
  ) => {
    const gateway = new ToolGateway(
      new ToolRegistry([toolDefinition()]),
      durable as never,
      [{ ref: REF, execute }],
    );
    const [tool] = authorizeOne(gateway);

    return tool.execute({ query: 'refunds' });
  };

  const leak =
    'Invalid `prisma.toolExecution.create()` invocation: connect ECONNREFUSED 10.0.0.5:5432';

  it('contains a failure to record the start', async () => {
    await expect(
      runWithDurable({
        start: () => Promise.reject(new Error(leak)),
        succeed: () => Promise.resolve(),
        fail: () => Promise.resolve(),
      }),
    ).rejects.toThrow('could not be completed');
  });

  it('contains a failure to record the success', async () => {
    let thrown: unknown;
    try {
      await runWithDurable({
        start: () => Promise.resolve('execution-1'),
        succeed: () => Promise.reject(new Error(leak)),
        fail: () => Promise.resolve(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ToolExecutionFailure);
    expect((thrown as Error).message).not.toContain('ECONNREFUSED');
    expect((thrown as Error).message).not.toContain('10.0.0.5');
  });

  /** A failed durable write must not replace the contained failure either. */
  it('contains a failure to record the failure', async () => {
    const thrown = await runWithDurable(
      {
        start: () => Promise.resolve('execution-1'),
        succeed: () => Promise.resolve(),
        fail: () => Promise.reject(new Error(leak)),
      },
      // The implementation must fail for `fail` to be reached at all.
      () => Promise.reject(new Error('implementation exploded')),
    ).catch((error: unknown) => error);

    expect((thrown as Error).message).not.toContain('ECONNREFUSED');
    expect((thrown as Error).message).not.toContain('exploded');
  });
});

describe('ToolGateway invocation budget', () => {
  /**
   * The step ceiling bounds model round-trips, not tool calls: one assistant
   * step may emit many, and the SDK runs them all. Without this, the model
   * chooses how much the platform pays by repetition rather than by a
   * parameter the schema already refuses.
   */
  it('stops a run attempt calling without limit', async () => {
    const execute = jest.fn<ToolImplementation['execute']>(() =>
      Promise.resolve({ passages: [] }),
    );
    const { gateway } = gatewayWith(execute);
    const [tool] = authorizeOne(gateway);

    let calls = 0;
    for (;;) {
      try {
        await tool.execute({ query: 'refunds' });
        calls += 1;
        if (calls > 100) throw new Error('budget never exhausted');
      } catch (error) {
        expect((error as Error).message).toContain('tool-call budget');
        break;
      }
    }

    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(20);
    expect(execute).toHaveBeenCalledTimes(calls);
  });

  it('gives each authorization its own budget', async () => {
    const { gateway } = gatewayWith(() => Promise.resolve({ passages: [] }));

    const spend = async () => {
      const [tool] = authorizeOne(gateway);
      let calls = 0;
      for (;;) {
        try {
          await tool.execute({ query: 'refunds' });
          calls += 1;
        } catch {
          return calls;
        }
      }
    };

    expect(await spend()).toBe(await spend());
  });
});

/**
 * Parsed, not merely validated.
 *
 * Every schema today is a `.strict()` object of primitives, so the parsed value
 * and the raw one are identical and nothing distinguishes them. The promises
 * are stronger than that — `ToolExecutionService` records "as the application
 * parsed it, never as the caller sent it", and the gateway returns nothing it
 * did not parse — and the first schema to gain a default, a transform, or a
 * non-strict object would break both silently. These use such a schema.
 */
describe('ToolGateway uses the parsed value', () => {
  const transforming = toolDefinition({
    input: z
      .object({
        query: z.string().transform((value) => value.trim().toLowerCase()),
        depth: z.number().default(3),
      })
      .strict(),
    output: z
      .object({
        passages: z.array(z.string()),
        note: z.string().default('n/a'),
      })
      .strict(),
  });

  it('records and executes the parsed input, not the raw one', async () => {
    const seen: unknown[] = [];
    const durable = executions();
    const gateway = new ToolGateway(
      new ToolRegistry([transforming]),
      durable as never,
      [
        {
          ref: REF,
          execute: (input) => {
            seen.push(input);
            return Promise.resolve({ passages: [] });
          },
        },
      ],
    );
    const [tool] = authorizeOne(gateway);

    await tool.execute({ query: '  REFUNDS  ' });

    const parsed = { query: 'refunds', depth: 3 };
    expect(seen).toEqual([parsed]);
    expect(durable.start).toHaveBeenCalledWith(
      expect.objectContaining({ input: parsed }),
    );
  });

  it('returns and records the parsed output, not the raw one', async () => {
    const durable = executions();
    const gateway = new ToolGateway(
      new ToolRegistry([transforming]),
      durable as never,
      [{ ref: REF, execute: () => Promise.resolve({ passages: ['a'] }) }],
    );
    const [tool] = authorizeOne(gateway);

    const parsed = { passages: ['a'], note: 'n/a' };
    await expect(tool.execute({ query: 'refunds' })).resolves.toEqual(parsed);
    expect(durable.succeed).toHaveBeenCalledWith(
      'execution-1',
      'org_1',
      parsed,
    );
  });
});

/**
 * What the gateway does when the durable half refuses.
 *
 * The e2e suite proves the compare-and-set against PostgreSQL, which is where
 * the guarantee actually lives. These cover the gateway's half of the contract
 * — that a refused terminal write is never treated as a completed call — which
 * needs no database and would otherwise only be exercised behind one.
 */
describe('ToolGateway when a terminal write refuses', () => {
  const refusing = () =>
    Promise.reject(new Error('ToolExecution "x" could not transition'));

  it('does not return the output when the SUCCEEDED transition matched nothing', async () => {
    const durable = executions();
    durable.succeed.mockImplementation(refusing);
    const gateway = new ToolGateway(
      new ToolRegistry([toolDefinition()]),
      durable as never,
      [{ ref: REF, execute: () => Promise.resolve({ passages: ['a'] }) }],
    );
    const [tool] = authorizeOne(gateway);

    /**
     * The point of the whole correction. The implementation succeeded and its
     * output parsed, so before this change the gateway returned it to the model
     * while no durable row claimed the call had completed.
     */
    await expect(tool.execute({ query: 'refunds' })).rejects.toBeInstanceOf(
      ToolExecutionFailure,
    );
    await expect(tool.execute({ query: 'refunds' })).rejects.toThrow(
      'could not be completed',
    );
  });

  it('still fails the call when the FAILED transition matched nothing', async () => {
    const durable = executions();
    durable.fail.mockImplementation(refusing);
    const gateway = new ToolGateway(
      new ToolRegistry([toolDefinition()]),
      durable as never,
      [{ ref: REF, execute: () => Promise.reject(new Error('driver')) }],
    );
    const [tool] = authorizeOne(gateway);

    // Still contained, and still a failure: an unrecorded failure must not
    // become a successful call either.
    await expect(tool.execute({ query: 'refunds' })).rejects.toBeInstanceOf(
      ToolExecutionFailure,
    );
  });

  /** Nothing from the refusal reaches the value the SDK will serialize. */
  it('contains the transition failure like any other', async () => {
    const durable = executions();
    durable.succeed.mockImplementation(() =>
      Promise.reject(
        Object.assign(
          new Error('Invalid `prisma.toolExecution.updateMany()`'),
          {
            meta: { target: 'org_secret' },
          },
        ),
      ),
    );
    const gateway = new ToolGateway(
      new ToolRegistry([toolDefinition()]),
      durable as never,
      [{ ref: REF, execute: () => Promise.resolve({ passages: [] }) }],
    );
    const [tool] = authorizeOne(gateway);

    const failure = (await tool.execute({ query: 'refunds' }).then(
      () => null,
      (error: unknown) => error,
    )) as Error;

    expect(failure.message).toBe(
      'Tool "knowledge_search_v1" could not be completed',
    );
    expect(failure.stack).toBeUndefined();
    expect(Object.keys(failure)).toEqual([]);
    expect(JSON.stringify(failure)).toBe('{}');
    expect(JSON.stringify(failure.message)).not.toContain('prisma');
    expect(JSON.stringify(failure.message)).not.toContain('org_secret');
  });
});
