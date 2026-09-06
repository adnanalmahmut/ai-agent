import { describe, expect, it, jest } from '@jest/globals';
import { UnrecoverableError, type Job } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { MODEL_IDS } from '../../../../src/ai/models/model-catalog';
import { AgentConfigurationError } from '../../../../src/ai/agents/agent-configuration.error';
import { AgentDefinitionRegistry } from '../../../../src/ai/agents/agent-definition.registry';
import {
  AgentExecutionHandler,
  type AgentExecutionJob,
} from '../../../../src/workers/handlers/agent-execution.handler';
import type { AgentRunService } from '../../../../src/ai/execution/agent-run.service';
import { AgentRunner } from '../../../../src/ai/execution/agent-runner.service';
import {
  ExecuteAgentRunUseCase,
  type ExecuteAgentRunCommand,
} from '../../../../src/modules/runs';
import type {
  AgentDefinition,
  AgentOutputContract,
  AgentRun,
} from '../../../../src/ai/agents/agent.types';

const run: AgentRun = {
  id: 'run-1',
  agentId: 'test-agent',
  agentVersion: 1,
  organizationAgentVersionId: null,
  modelPolicyId: null,
  modelId: null,
  modelPricingRevisionId: null,
  runtime: 'mastra',
  status: 'RUNNING',
  organizationId: 'org-1',
  createdByUserId: 'user-1',
  input: 'hello',
  output: null,
  lastError: null,
  attemptCount: 1,
  idempotencyKey: 'request-1',
  startedAt: new Date('2026-08-22T00:00:00.000Z'),
  completedAt: null,
  createdAt: new Date('2026-08-22T00:00:00.000Z'),
  updatedAt: new Date('2026-08-22T00:00:00.000Z'),
};

function job(
  attemptsMade: number,
  attempts = 3,
  attemptsStarted = attemptsMade + 1,
): Job<AgentExecutionJob> {
  return {
    data: { runId: run.id },
    attemptsMade,
    attemptsStarted,
    opts: { attempts },
  } as Job<AgentExecutionJob>;
}

function harness() {
  const claimExecutionAttempt =
    jest.fn<
      (runId: string, attemptsStarted: number) => Promise<AgentRun | null>
    >();
  const markExecutionSucceeded =
    jest.fn<
      (runId: string, attemptCount: number, output: unknown) => Promise<boolean>
    >();
  const recordExecutionFailure =
    jest.fn<
      (
        runId: string,
        attemptCount: number,
        lastError: string,
        final: boolean,
      ) => Promise<boolean>
    >();
  const runs = {
    claimExecutionAttempt,
    markExecutionSucceeded,
    recordExecutionFailure,
  };
  const runAgent =
    jest.fn<
      (
        value: AgentRun,
      ) => Promise<{ output: null | boolean | number | string | object }>
    >();
  const runner = {
    run: runAgent,
  };
  const warn = jest.fn();
  const logger = { warn } as unknown as PinoLogger;
  const handler = new AgentExecutionHandler(
    new ExecuteAgentRunUseCase(
      runs as unknown as AgentRunService,
      runner as unknown as AgentRunner,
    ),
    logger,
  );

  return { handler, runner, runs, warn };
}

describe('AgentExecutionHandler', () => {
  it('treats terminal or already-claimed duplicate delivery as a no-op', async () => {
    const { handler, runner, runs } = harness();
    runs.claimExecutionAttempt.mockResolvedValue(null);

    await expect(handler.handle(job(0))).resolves.toBeUndefined();

    expect(runner.run).not.toHaveBeenCalled();
    expect(runs.markExecutionSucceeded).not.toHaveBeenCalled();
  });

  it('records successful output against the claimed attempt', async () => {
    const { handler, runner, runs } = harness();
    runs.claimExecutionAttempt.mockResolvedValue(run);
    runner.run.mockResolvedValue({ output: { answer: 'done' } });
    runs.markExecutionSucceeded.mockResolvedValue(true);

    await expect(handler.handle(job(0))).resolves.toBeUndefined();

    expect(runs.markExecutionSucceeded).toHaveBeenCalledWith(
      run.id,
      run.attemptCount,
      { answer: 'done' },
    );
    expect(runs.recordExecutionFailure).not.toHaveBeenCalled();
  });

  it('keeps a non-final failure retryable and stores only a safe diagnostic', async () => {
    const { handler, runner, runs } = harness();
    runs.claimExecutionAttempt.mockResolvedValue(run);
    const providerError = new Error('provider response included SECRET_VALUE');
    providerError.name = 'sk-proj-SECRET_VALUE';
    runner.run.mockRejectedValue(providerError);
    runs.recordExecutionFailure.mockResolvedValue(true);

    await expect(handler.handle(job(0, 3))).rejects.toThrow(
      'Agent execution failed',
    );

    expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
      run.id,
      run.attemptCount,
      'Agent execution failed',
      false,
    );
  });

  it('uses the active-start ordinal when BullMQ redelivers a stalled job', async () => {
    const { handler, runner, runs } = harness();
    runs.claimExecutionAttempt.mockResolvedValue({ ...run, attemptCount: 2 });
    runner.run.mockResolvedValue({ output: 'recovered' });
    runs.markExecutionSucceeded.mockResolvedValue(true);

    await handler.handle(job(0, 3, 2));

    expect(runs.claimExecutionAttempt).toHaveBeenCalledWith(run.id, 2);
    expect(runs.markExecutionSucceeded).toHaveBeenCalledWith(
      run.id,
      2,
      'recovered',
    );
  });

  it('reports a lost claim to BullMQ without leaking the internal reason', async () => {
    const { handler, runner, runs, warn } = harness();
    runs.claimExecutionAttempt.mockResolvedValue(run);
    runner.run.mockResolvedValue({ output: 'done' });
    runs.markExecutionSucceeded.mockResolvedValue(false);

    await expect(handler.handle(job(0))).rejects.toThrow(
      'Agent execution failed',
    );

    expect(runs.recordExecutionFailure).not.toHaveBeenCalled();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.id, reason: 'claim_lost' }),
      expect.any(String),
    );
  });

  it('writes the failure against the claimed ordinal, not the BullMQ retry count', async () => {
    const { handler, runner, runs } = harness();
    runs.claimExecutionAttempt.mockResolvedValue({ ...run, attemptCount: 5 });
    runner.run.mockRejectedValue(new Error('private provider detail'));
    runs.recordExecutionFailure.mockResolvedValue(true);

    await expect(handler.handle(job(2, 3, 5))).rejects.toThrow(
      'Agent execution failed',
    );

    expect(runs.claimExecutionAttempt).toHaveBeenCalledWith(run.id, 5);
    expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
      run.id,
      5,
      'Agent execution failed',
      true,
    );
  });

  it('derives finality from attemptsMade, not the active-start ordinal', async () => {
    const { handler, runner, runs } = harness();
    runs.claimExecutionAttempt.mockResolvedValue({ ...run, attemptCount: 5 });
    runner.run.mockRejectedValue(new Error('private provider detail'));
    runs.recordExecutionFailure.mockResolvedValue(true);

    await expect(handler.handle(job(1, 3, 5))).rejects.toThrow(
      'Agent execution failed',
    );

    expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
      run.id,
      5,
      'Agent execution failed',
      false,
    );
  });

  it('treats a job with no configured attempts as single-shot', async () => {
    const { handler, runner, runs } = harness();
    runs.claimExecutionAttempt.mockResolvedValue(run);
    runner.run.mockRejectedValue(new Error('private provider detail'));
    runs.recordExecutionFailure.mockResolvedValue(true);

    const attemptless = {
      data: { runId: run.id },
      attemptsMade: 0,
      attemptsStarted: 1,
      opts: {},
    } as Job<AgentExecutionJob>;

    await expect(handler.handle(attemptless)).rejects.toThrow(
      'Agent execution failed',
    );

    expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
      run.id,
      run.attemptCount,
      'Agent execution failed',
      true,
    );
  });

  it('marks the business run failed only on BullMQ final attempt', async () => {
    const { handler, runner, runs } = harness();
    runs.claimExecutionAttempt.mockResolvedValue({ ...run, attemptCount: 3 });
    runner.run.mockRejectedValue(new Error('private provider detail'));
    runs.recordExecutionFailure.mockResolvedValue(true);

    await expect(handler.handle(job(2, 3))).rejects.toThrow(
      'Agent execution failed',
    );

    expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
      run.id,
      3,
      'Agent execution failed',
      true,
    );
  });

  describe('a deterministic configuration failure', () => {
    const registryError = () =>
      new AgentConfigurationError(
        'agent "test-agent" version 1 is not in the registry',
      );

    it('stops the retries on the first attempt instead of spending the budget', async () => {
      const { handler, runner, runs } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(run);
      runner.run.mockRejectedValue(registryError());
      runs.recordExecutionFailure.mockResolvedValue(true);

      const error = await handler.handle(job(0, 3)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).name).toBe('UnrecoverableError');
      expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
        run.id,
        run.attemptCount,
        'Agent execution failed',
        true,
      );
    });

    it('carries none of the registry message into what BullMQ records', async () => {
      const { handler, runner, runs } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(run);
      runner.run.mockRejectedValue(registryError());
      runs.recordExecutionFailure.mockResolvedValue(true);

      const error = await handler.handle(job(0, 3)).catch((e: unknown) => e);

      expect((error as Error).message).toBe('Agent execution failed');
    });

    it('distinguishes it from a runtime failure with a fixed reason code', async () => {
      const { handler, runner, runs, warn } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(run);
      runner.run.mockRejectedValue(registryError());
      runs.recordExecutionFailure.mockResolvedValue(true);

      await expect(handler.handle(job(0, 3))).rejects.toThrow();

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: run.id,
          agentId: run.agentId,
          agentVersion: run.agentVersion,
          reason: 'configuration_error',
          final: true,
        }),
        expect.any(String),
      );
    });

    it('reports it without copying anything out of the error', async () => {
      const { handler, runner, runs, warn } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(run);
      runner.run.mockRejectedValue(
        new AgentConfigurationError('leaked provider detail sk-proj-SECRET'),
      );
      runs.recordExecutionFailure.mockResolvedValue(true);

      await expect(handler.handle(job(0, 3))).rejects.toThrow();

      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain('SECRET');
      expect(logged).not.toContain('leaked provider detail');
      expect(logged).not.toContain('AgentConfigurationError');
    });

    it('rejects retryably when it no longer owns the run it would have failed', async () => {
      const { handler, runner, runs } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(run);
      runner.run.mockRejectedValue(registryError());
      runs.recordExecutionFailure.mockResolvedValue(false);

      const error = await handler.handle(job(0, 3)).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect((error as Error).name).toBe('Error');
      expect((error as Error).message).toBe('Agent execution failed');
    });

    it('reports the lost claim rather than the classification', async () => {
      const { handler, runner, runs, warn } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(run);
      runner.run.mockRejectedValue(registryError());
      runs.recordExecutionFailure.mockResolvedValue(false);

      await expect(handler.handle(job(0, 3))).rejects.toThrow();

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run.id, reason: 'claim_lost' }),
        expect.any(String),
      );
      expect(warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'configuration_error' }),
        expect.any(String),
      );
    });

    it('cannot be spoofed by an error that merely names itself one', async () => {
      const { handler, runner, runs, warn } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(run);
      const impostor = new Error(
        'agent "test-agent" version 1 is not in the registry',
      );
      impostor.name = 'AgentConfigurationError';
      runner.run.mockRejectedValue(impostor);
      runs.recordExecutionFailure.mockResolvedValue(true);

      const error = await handler.handle(job(0, 3)).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect((error as Error).name).toBe('Error');
      expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
        run.id,
        run.attemptCount,
        'Agent execution failed',
        false,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'runtime_error' }),
        expect.any(String),
      );
    });

    it('leaves an ordinary failure to the retry budget it was given', async () => {
      const { handler, runner, runs, warn } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(run);
      runner.run.mockRejectedValue(new Error('provider timed out'));
      runs.recordExecutionFailure.mockResolvedValue(true);

      const error = await handler.handle(job(0, 3)).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect((error as Error).name).toBe('Error');
      expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
        run.id,
        run.attemptCount,
        'Agent execution failed',
        false,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'runtime_error', final: false }),
        expect.any(String),
      );
    });
  });
});

describe('a declared output contract violation, through the worker', () => {
  const contractedDefinition = {
    id: 'test-agent',
    version: 1,
    runtime: 'mastra',
    instructions: 'Answer test requests.',
    model: MODEL_IDS.openAiGpt4oMini,
    modelPolicy: {
      id: 'test-agent.model-policy.1',
      allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
    },
    input: z.object({ wanted: z.number() }),
    output: z.object({ items: z.array(z.string()) }).strict(),
    outputContract: ((input, output) => {
      const expected = (input as { wanted: number }).wanted;
      const received = (output as { items: string[] }).items.length;

      return received === expected
        ? null
        : { code: 'count_mismatch', expected, received };
    }) satisfies AgentOutputContract,
  } as AgentDefinition;

  const realRunner = (providerOutput: unknown) =>
    new AgentRunner(
      new AgentDefinitionRegistry([contractedDefinition]),
      {
        resolve: jest.fn(() => ({
          name: 'mastra',
          run: () => Promise.resolve({ output: providerOutput as never }),
        })),
      } as never,
      { assemble: () => Promise.resolve([]) },
      { pinnedVersionFor: () => Promise.resolve(null) } as never,
      { authorize: () => [] } as never,
    );

  const contractedRun: AgentRun = { ...run, input: { wanted: 3 } };

  it('is retried rather than made final, and named as its own reason', async () => {
    const { runs, warn } = harness();
    runs.claimExecutionAttempt.mockResolvedValue(contractedRun);
    runs.recordExecutionFailure.mockResolvedValue(true);

    const handlerWithRealRunner = new AgentExecutionHandler(
      new ExecuteAgentRunUseCase(
        runs as unknown as AgentRunService,
        realRunner({ items: ['only', 'two'] }),
      ),
      { warn } as unknown as PinoLogger,
    );

    const error = await handlerWithRealRunner
      .handle(job(0, 3))
      .catch((thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
      contractedRun.id,
      contractedRun.attemptCount,
      'Agent execution failed',
      false,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'contract_violation', final: false }),
      expect.any(String),
    );

    expect((error as Error).message).toBe('Agent execution failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('count_mismatch');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('expected 3');
    expect(runs.markExecutionSucceeded).not.toHaveBeenCalled();
  });

  it('records a satisfied contract as a success', async () => {
    const { runs } = harness();
    runs.claimExecutionAttempt.mockResolvedValue(contractedRun);
    runs.markExecutionSucceeded.mockResolvedValue(true);

    const handlerWithRealRunner = new AgentExecutionHandler(
      new ExecuteAgentRunUseCase(
        runs as unknown as AgentRunService,
        realRunner({ items: ['a', 'b', 'c'] }),
      ),
      { warn: jest.fn() } as unknown as PinoLogger,
    );

    await expect(
      handlerWithRealRunner.handle(job(0, 3)),
    ).resolves.toBeUndefined();

    expect(runs.markExecutionSucceeded).toHaveBeenCalledWith(
      contractedRun.id,
      contractedRun.attemptCount,
      { items: ['a', 'b', 'c'] },
    );
    expect(runs.recordExecutionFailure).not.toHaveBeenCalled();
  });
});

describe('what the queue adapter hands the Control Plane', () => {
  const spyHarness = () => {
    const execute =
      jest.fn<
        (
          command: ExecuteAgentRunCommand,
        ) => Promise<{ status: 'not_claimed'; runId: string }>
      >();
    execute.mockResolvedValue({ status: 'not_claimed', runId: run.id });

    const handler = new AgentExecutionHandler(
      { execute } as unknown as ExecuteAgentRunUseCase,
      { warn: jest.fn() } as unknown as PinoLogger,
    );

    return { handler, execute };
  };

  it('translates the delivery into a run id, an ordinal and a last-delivery flag', async () => {
    const { handler, execute } = spyHarness();

    await handler.handle(job(1, 3, 2));

    expect(execute).toHaveBeenCalledWith({
      runId: 'run-1',
      attempt: 2,
      lastDelivery: false,
    });
  });

  it('says so when the queue has no redelivery left', async () => {
    const { handler, execute } = spyHarness();

    await handler.handle(job(2, 3, 3));

    expect(execute).toHaveBeenCalledWith({
      runId: 'run-1',
      attempt: 3,
      lastDelivery: true,
    });
  });

  it('treats a job configured without an attempt budget as a single delivery', async () => {
    const { handler, execute } = spyHarness();

    await handler.handle({
      data: { runId: run.id },
      attemptsMade: 0,
      attemptsStarted: 1,
      opts: {},
    } as Job<AgentExecutionJob>);

    expect(execute).toHaveBeenCalledWith({
      runId: 'run-1',
      attempt: 1,
      lastDelivery: true,
    });
  });

  it('passes no part of the job itself', async () => {
    const { handler, execute } = spyHarness();

    await handler.handle(job(0, 3));

    const [command] = execute.mock.calls[0];

    expect(Object.keys(command).sort()).toEqual([
      'attempt',
      'lastDelivery',
      'runId',
    ]);
    for (const value of Object.values(command)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });

  it('rejects a job with no run id before asking the Control Plane anything', async () => {
    const { handler, execute } = spyHarness();

    await expect(
      handler.handle({
        data: {},
        attemptsMade: 0,
        attemptsStarted: 1,
        opts: { attempts: 3 },
      } as Job<AgentExecutionJob>),
    ).rejects.toThrow('Agent execution job requires a runId');

    expect(execute).not.toHaveBeenCalled();
  });
});
