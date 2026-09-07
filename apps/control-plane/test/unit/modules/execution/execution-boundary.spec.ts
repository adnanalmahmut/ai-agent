import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

import type { AgentDefinitionRegistry } from '../../../../src/ai/agents/agent-definition.registry';
import type {
  AgentDefinition,
  AgentRun,
} from '../../../../src/ai/agents/agent.types';
import type { AgentContextPort } from '../../../../src/ai/execution/agent-context.port';
import type { AgentRunService } from '../../../../src/ai/execution/agent-run.service';
import type { ToolRegistry } from '../../../../src/ai/tools/tool.registry';
import { MODEL_IDS } from '../../../../src/ai/models/model-catalog';
import {
  ExecutionStepAssembler,
  LeaseExecutionStepUseCase,
  SettleExecutionStepUseCase,
  stepIdFor,
} from '../../../../src/modules/execution';

const ACCEPTED_AT = new Date('2026-02-01T09:00:00.000Z');

const definition = (
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition =>
  ({
    id: 'support-answer',
    version: 3,
    runtime: 'mastra',
    model: MODEL_IDS.openAiGpt4oMini,
    modelPolicy: {
      id: 'policy_default',
      allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
    },
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string() }),
    maxToolGrants: ['knowledge.search@1'],
    contextPolicy: {
      spaceSlugs: ['policies'],
      maxChunks: 4,
      maxCharacters: 400,
    },
    ...overrides,
  }) as unknown as AgentDefinition;

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: 'run_1',
  agentId: 'support-answer',
  agentVersion: 3,
  organizationAgentVersionId: 'orgver_1',
  modelPolicyId: null,
  modelId: null,
  modelPricingRevisionId: null,
  runtime: 'mastra',
  status: 'RUNNING',
  organizationId: 'org_1',
  createdByUserId: null,
  input: { question: 'What is the refund window?' },
  output: null,
  lastError: null,
  attemptCount: 1,
  idempotencyKey: 'key_1',
  startedAt: ACCEPTED_AT,
  completedAt: null,
  createdAt: ACCEPTED_AT,
  updatedAt: ACCEPTED_AT,
  ...overrides,
});

function harness(
  options: {
    runs?: Partial<AgentRunService>;
    definitions?: Partial<AgentDefinitionRegistry>;
    passages?: Awaited<ReturnType<AgentContextPort['assemble']>>;
    toolGrants?: readonly string[];
    registeredTools?: readonly string[];
  } = {},
) {
  const rows = new Map<string, AgentRun>();
  const stored = options.runs ?? {};

  const mocks = {
    findById: jest.fn<AgentRunService['findById']>((runId) =>
      Promise.resolve(rows.get(runId) ?? null),
    ),
    claimExecutionAttempt: jest.fn<AgentRunService['claimExecutionAttempt']>(
      (runId, attempt) => {
        const current = rows.get(runId);

        if (!current || current.attemptCount >= attempt) {
          return Promise.resolve(null);
        }

        const claimed = {
          ...current,
          status: 'RUNNING',
          attemptCount: attempt,
        } as AgentRun;
        rows.set(runId, claimed);

        return Promise.resolve(claimed);
      },
    ),
    markExecutionSucceeded: jest.fn<AgentRunService['markExecutionSucceeded']>(
      (runId, attemptCount, output) => {
        const current = rows.get(runId);

        if (
          !current ||
          current.status !== 'RUNNING' ||
          current.attemptCount !== attemptCount
        ) {
          return Promise.resolve(false);
        }

        rows.set(runId, { ...current, status: 'SUCCEEDED', output });

        return Promise.resolve(true);
      },
    ),
    recordExecutionFailure: jest.fn<AgentRunService['recordExecutionFailure']>(
      (runId, attemptCount, lastError, final) => {
        const current = rows.get(runId);

        if (
          !current ||
          current.status !== 'RUNNING' ||
          current.attemptCount !== attemptCount
        ) {
          return Promise.resolve(false);
        }

        rows.set(runId, {
          ...current,
          lastError,
          status: final ? 'FAILED' : current.status,
        });

        return Promise.resolve(true);
      },
    ),
    pinnedVersionFor: jest.fn<AgentRunService['pinnedVersionFor']>(() =>
      Promise.resolve({
        configuration: {},
        toolGrants: options.toolGrants ?? ['knowledge.search@1'],
      }),
    ),
  };
  const runs = { ...mocks, ...stored } as unknown as AgentRunService;

  const definitions = {
    resolve: jest.fn(() => definition()),
    ...options.definitions,
  } as unknown as AgentDefinitionRegistry;

  const registered = new Set(options.registeredTools ?? ['knowledge.search@1']);
  const tools = {
    has: (ref: string) => registered.has(ref),
  } as unknown as ToolRegistry;

  const context: AgentContextPort = {
    assemble: jest.fn<AgentContextPort['assemble']>(() =>
      Promise.resolve([...(options.passages ?? [])]),
    ),
  };

  const assembler = new ExecutionStepAssembler(
    definitions,
    runs,
    tools,
    context,
  );

  return {
    rows,
    runs,
    // Asserted on directly: reading the same function off the service type
    // would detach a class method from its receiver.
    mocks,
    definitions,
    context,
    assembler,
    lease: new LeaseExecutionStepUseCase(runs, assembler),
    settle: new SettleExecutionStepUseCase(runs, definitions),
    seed(overrides: Partial<AgentRun> = {}) {
      const seeded = run({ status: 'QUEUED', attemptCount: 0, ...overrides });
      rows.set(seeded.id, seeded);

      return seeded;
    },
  };
}

const resultFor = (
  overrides: Record<string, unknown> = {},
  attempt = 1,
): Record<string, unknown> => ({
  version: '1',
  stepId: stepIdFor('run_1', attempt),
  runId: 'run_1',
  attempt,
  outcome: 'final',
  output: { answer: 'Thirty days.' },
  artifacts: [],
  ...overrides,
});

describe('leasing an execution step', () => {
  it('serialises the step from durable state, with nothing a caller supplied', async () => {
    const h = harness({
      passages: [
        {
          space: 'policies',
          content: 'Refunds within thirty days.',
          documentId: 'doc_1',
          chunkId: 'chunk_1',
        },
      ],
    });
    h.seed();

    const outcome = await h.lease.execute({ runId: 'run_1' });

    expect(outcome.status).toBe('leased');
    if (outcome.status !== 'leased') throw new Error('not leased');

    expect(outcome.step).toEqual({
      version: '1',
      stepId: 'run_1:1',
      runId: 'run_1',
      organizationId: 'org_1',
      attempt: 1,
      acceptedAt: '2026-02-01T09:00:00.000Z',
      agent: { id: 'support-answer', version: 3 },
      model: {
        policyId: 'policy_default',
        modelId: MODEL_IDS.openAiGpt4oMini,
        pricingRevisionId: expect.any(String) as unknown as string,
      },
      input: { question: 'What is the refund window?' },
      context: [
        {
          documentId: 'doc_1',
          chunkId: 'chunk_1',
          text: 'Refunds within thirty days.',
        },
      ],
      grantedTools: ['knowledge.search@1'],
    });
  });

  it('is JSON, whole: no Date, function or class instance survives assembly', async () => {
    const h = harness();
    h.seed();

    const outcome = await h.lease.execute({ runId: 'run_1' });
    if (outcome.status !== 'leased') throw new Error('not leased');

    expect(JSON.parse(JSON.stringify(outcome.step))).toEqual(outcome.step);
  });

  it('derives the fencing token itself rather than taking one from the caller', async () => {
    const h = harness();
    h.seed({ attemptCount: 7 });

    const outcome = await h.lease.execute({ runId: 'run_1' });
    if (outcome.status !== 'leased') throw new Error('not leased');

    expect(outcome.step.attempt).toBe(8);
    expect(h.mocks.claimExecutionAttempt).toHaveBeenCalledWith('run_1', 8);
  });

  it('claims before it assembles, so a step never describes unheld work', async () => {
    const order: string[] = [];
    const h = harness();
    h.seed();
    jest
      .spyOn(h.runs, 'claimExecutionAttempt')
      .mockImplementation((runId, attempt) => {
        order.push('claim');

        return Promise.resolve(run({ id: runId, attemptCount: attempt }));
      });
    jest.spyOn(h.context, 'assemble').mockImplementation(() => {
      order.push('assemble');

      return Promise.resolve([]);
    });

    await h.lease.execute({ runId: 'run_1' });

    expect(order).toEqual(['claim', 'assemble']);
  });

  it('answers an unknown run and another tenant’s run identically', async () => {
    const h = harness();
    h.seed();

    await expect(h.lease.execute({ runId: 'run_absent' })).resolves.toEqual({
      status: 'not_found',
    });
    await expect(
      h.lease.execute({ runId: 'run_1', assertedOrganizationId: 'org_other' }),
    ).resolves.toEqual({ status: 'not_found' });
    expect(h.mocks.claimExecutionAttempt).not.toHaveBeenCalled();
  });

  it('accepts a matching tenant assertion without letting it find anything', async () => {
    const h = harness();
    h.seed();

    const outcome = await h.lease.execute({
      runId: 'run_1',
      assertedOrganizationId: 'org_1',
    });

    expect(outcome.status).toBe('leased');
    expect(h.mocks.findById).toHaveBeenCalledWith('run_1');
  });

  it('does not lease a terminal run', async () => {
    const h = harness();
    h.seed({ status: 'SUCCEEDED', attemptCount: 1 });
    jest.spyOn(h.runs, 'claimExecutionAttempt').mockResolvedValue(null);

    await expect(h.lease.execute({ runId: 'run_1' })).resolves.toEqual({
      status: 'not_claimed',
    });
  });

  it('refuses a run whose pinned definition disagrees with it, and settles the claim', async () => {
    const h = harness({
      definitions: {
        resolve: jest.fn(() => definition({ runtime: 'other' as never })),
      } as unknown as Partial<AgentDefinitionRegistry>,
    });
    h.seed();

    const outcome = await h.lease.execute({ runId: 'run_1' });

    expect(outcome.status).toBe('not_executable');
    expect(h.mocks.recordExecutionFailure).toHaveBeenCalledWith(
      'run_1',
      1,
      'Agent execution failed',
      true,
    );
  });

  it('refuses a grant the pinned definition does not allow', async () => {
    const h = harness({
      toolGrants: ['notification.send@1'],
      registeredTools: ['knowledge.search@1', 'notification.send@1'],
    });
    h.seed();

    await expect(h.lease.execute({ runId: 'run_1' })).resolves.toMatchObject({
      status: 'not_executable',
    });
  });

  it('refuses a partially populated model pin rather than completing it', async () => {
    const h = harness();
    h.seed({ modelPolicyId: 'policy_default' });

    await expect(h.lease.execute({ runId: 'run_1' })).resolves.toMatchObject({
      status: 'not_executable',
    });
  });

  it('refuses a model outside the pinned definition policy', async () => {
    const h = harness();
    h.seed({
      modelPolicyId: 'policy_other',
      modelId: MODEL_IDS.openAiGpt4oMini,
      modelPricingRevisionId: 'rev_1',
    });

    await expect(h.lease.execute({ runId: 'run_1' })).resolves.toMatchObject({
      status: 'not_executable',
    });
  });

  it('refuses an input the pinned definition does not accept', async () => {
    const h = harness();
    h.seed({ input: { question: 42 } as never });

    await expect(h.lease.execute({ runId: 'run_1' })).resolves.toMatchObject({
      status: 'not_executable',
    });
  });

  it('rejects a step that would exceed the aggregate context budget', async () => {
    const h = harness({
      passages: Array.from({ length: 2 }, (_unused, index) => ({
        space: 'policies',
        content: 'x'.repeat(11_000),
        documentId: `doc_${index}`,
        chunkId: `chunk_${index}`,
      })),
    });
    h.seed();

    await expect(h.lease.execute({ runId: 'run_1' })).resolves.toMatchObject({
      status: 'not_executable',
    });
  });
});

describe('settling an execution step', () => {
  it('applies a valid final result through the durable compare-and-set', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await expect(
      h.settle.execute({ runId: 'run_1', document: resultFor() }),
    ).resolves.toEqual({ status: 'settled' });
    expect(h.rows.get('run_1')?.status).toBe('SUCCEEDED');
  });

  it('validates the document before reading a field of it', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    const outcome = await h.settle.execute({
      runId: 'run_1',
      document: { version: '1', outcome: 'final' },
    });

    expect(outcome.status).toBe('invalid_document');
    expect(h.mocks.findById).toHaveBeenCalledTimes(1); // the lease only
  });

  it('rejects a document written against another contract version', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: resultFor({ version: '2' }),
      }),
    ).resolves.toMatchObject({ status: 'invalid_document' });
  });

  it('rejects a non-JSON value the schema alone would have accepted', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: resultFor({ output: { answeredAt: new Date() } }),
      }),
    ).resolves.toMatchObject({ status: 'invalid_document' });
  });

  it('rejects an output whose nested property name looks like a credential', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: resultFor({
          output: { answer: 'ok', nested: { api_key: 'sk-live-1' } },
        }),
      }),
    ).resolves.toMatchObject({ status: 'invalid_document' });
  });

  it('rejects an output over the document byte budget', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: resultFor({ output: { answer: 'x'.repeat(1_100_000) } }),
      }),
    ).resolves.toMatchObject({ status: 'invalid_document' });
  });

  it('rejects an approval claim rather than reading past it', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: resultFor({ approved: true }),
      }),
    ).resolves.toMatchObject({ status: 'invalid_document' });
  });

  it('rejects a result whose step identity is not the run in the route', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: resultFor({ stepId: 'run_2:1' }),
      }),
    ).resolves.toEqual({ status: 'identity_mismatch' });
    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: resultFor({ runId: 'run_2', stepId: 'run_2:1' }),
      }),
    ).resolves.toEqual({ status: 'identity_mismatch' });
  });

  it('answers an unknown run and another tenant’s run identically', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await expect(
      h.settle.execute({
        runId: 'run_absent',
        document: resultFor({ runId: 'run_absent', stepId: 'run_absent:1' }),
      }),
    ).resolves.toEqual({ status: 'not_found' });
    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: resultFor(),
        assertedOrganizationId: 'org_other',
      }),
    ).resolves.toEqual({ status: 'not_found' });
    expect(h.rows.get('run_1')?.status).toBe('RUNNING');
  });

  it('refuses an answer from a worker whose attempt has moved on', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });
    await h.runs.claimExecutionAttempt('run_1', 2);

    await expect(
      h.settle.execute({ runId: 'run_1', document: resultFor({}, 1) }),
    ).resolves.toEqual({ status: 'stale' });
    expect(h.rows.get('run_1')?.status).toBe('RUNNING');
  });

  it('refuses an output the pinned definition does not accept, keeping the retry budget', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: resultFor({ output: { answer: 7 } }),
      }),
    ).resolves.toEqual({ status: 'output_rejected' });

    const current = h.rows.get('run_1');
    expect(current?.status).toBe('RUNNING');
    expect(current?.lastError).toBe('Agent execution failed');
  });

  it('replaying the identical result changes nothing and is not an error', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await h.settle.execute({ runId: 'run_1', document: resultFor() });
    const settled = h.rows.get('run_1');

    await expect(
      h.settle.execute({ runId: 'run_1', document: resultFor() }),
    ).resolves.toEqual({ status: 'already_settled' });
    expect(h.rows.get('run_1')).toEqual(settled);
  });

  it('treats property order as no difference at all', async () => {
    const h = harness({
      definitions: {
        resolve: jest.fn(() =>
          definition({
            output: z.object({ answer: z.string(), source: z.string() }),
          }),
        ),
      } as unknown as Partial<AgentDefinitionRegistry>,
    });
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await h.settle.execute({
      runId: 'run_1',
      document: resultFor({ output: { answer: 'a', source: 'b' } }),
    });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: resultFor({ output: { source: 'b', answer: 'a' } }),
      }),
    ).resolves.toEqual({ status: 'already_settled' });
  });

  it('refuses a different answer for work that is already settled', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await h.settle.execute({ runId: 'run_1', document: resultFor() });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: resultFor({ output: { answer: 'Ninety days.' } }),
      }),
    ).resolves.toEqual({ status: 'conflict' });
    expect(h.rows.get('run_1')?.output).toEqual({ answer: 'Thirty days.' });
  });

  it('records a reported failure with its own diagnostic, not the caller’s', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: {
          version: '1',
          stepId: 'run_1:1',
          runId: 'run_1',
          attempt: 1,
          outcome: 'failed',
          failure: { version: '1', code: 'timeout' },
        },
      }),
    ).resolves.toEqual({ status: 'settled' });

    const current = h.rows.get('run_1');
    expect(current?.lastError).toBe('Agent execution failed');
    expect(current?.status).toBe('RUNNING');
  });

  it('refuses a failure report that contradicts a recorded success', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });
    await h.settle.execute({ runId: 'run_1', document: resultFor() });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: {
          version: '1',
          stepId: 'run_1:1',
          runId: 'run_1',
          attempt: 1,
          outcome: 'failed',
          failure: { version: '1', code: 'timeout' },
        },
      }),
    ).resolves.toEqual({ status: 'conflict' });

    const current = h.rows.get('run_1');
    expect(current?.status).toBe('SUCCEEDED');
    expect(current?.output).toEqual({ answer: 'Thirty days.' });
  });

  it('treats a repeated failure report as the answer already recorded', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });
    const failure = {
      version: '1',
      stepId: 'run_1:1',
      runId: 'run_1',
      attempt: 1,
      outcome: 'failed',
      failure: { version: '1', code: 'timeout' },
    };

    await h.settle.execute({ runId: 'run_1', document: failure });
    await h.runs.recordExecutionFailure(
      'run_1',
      1,
      'Agent execution failed',
      true,
    );

    await expect(
      h.settle.execute({ runId: 'run_1', document: failure }),
    ).resolves.toEqual({ status: 'already_settled' });
  });

  it('does not acknowledge a tool proposal it cannot perform', async () => {
    const h = harness();
    h.seed();
    await h.lease.execute({ runId: 'run_1' });

    await expect(
      h.settle.execute({
        runId: 'run_1',
        document: {
          version: '1',
          stepId: 'run_1:1',
          runId: 'run_1',
          attempt: 1,
          outcome: 'tool_request',
          invocations: [
            {
              version: '1',
              invocationId: 'inv_1',
              tool: 'knowledge.search@1',
              input: { query: 'refunds' },
            },
          ],
        },
      }),
    ).resolves.toEqual({
      status: 'unsupported_outcome',
      outcome: 'tool_request',
    });

    const current = h.rows.get('run_1');
    expect(current?.status).toBe('RUNNING');
    expect(current?.output).toBeNull();
    expect(current?.lastError).toBeNull();
  });
});
