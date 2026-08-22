import { describe, expect, it, jest } from '@jest/globals';
import type { Job } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';

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
  const warn = jest.fn();
  const logger = { warn } as unknown as PinoLogger;
  const handler = new AgentExecutionHandler(
    runs as unknown as AgentRunService,
    runner as unknown as AgentRunner,
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
    // Another delivery superseded this worker while its model call was in
    // flight, so the CAS matches nothing.
    runs.markExecutionSucceeded.mockResolvedValue(false);

    // Only the constant diagnostic crosses into BullMQ's failedReason.
    await expect(handler.handle(job(0))).rejects.toThrow(
      'Agent execution failed',
    );

    // The superseding delivery owns the outcome, so this worker must not write
    // a failure against an attempt it no longer holds.
    expect(runs.recordExecutionFailure).not.toHaveBeenCalled();

    // The cause is still observable to an operator, as a fixed code rather
    // than anything derived from the error.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.id, reason: 'claim_lost' }),
      expect.any(String),
    );
  });

  it('writes the failure against the claimed ordinal, not the BullMQ retry count', async () => {
    const { handler, runner, runs } = harness();
    // Stalls have desynchronized the two counters: five active starts, two
    // finished attempts. The durable write must use the claimed ordinal, while
    // finality still comes from attemptsMade.
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
    // Five active starts but only two finished attempts: stalls consume start
    // ordinals without consuming retry budget. Classifying finality from
    // attemptsStarted (5 >= 3) would mark this run FAILED while BullMQ still
    // has a retry left.
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

    // A job published with no `attempts` — a misconfigured queue or a
    // hand-enqueued job. Without the `?? 1` fallback the run would stay
    // RUNNING forever: no retry is coming, but nothing records the failure.
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
});
