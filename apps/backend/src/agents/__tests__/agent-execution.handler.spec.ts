import { describe, expect, it, jest } from '@jest/globals';
import type { Job } from 'bullmq';

import {
  AgentExecutionHandler,
  type AgentExecutionJob,
} from '../agent-execution.handler';
import type { AgentRunService } from '../agent-run.service';
import type { AgentRunner } from '../agent-runner.service';
import type { AgentRun } from '../agent.types';

const run: AgentRun = {
  id: 'run-1',
  agentId: 'test-agent',
  agentVersion: 1,
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
  const handler = new AgentExecutionHandler(
    runs as unknown as AgentRunService,
    runner as unknown as AgentRunner,
  );

  return { handler, runner, runs };
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
});
