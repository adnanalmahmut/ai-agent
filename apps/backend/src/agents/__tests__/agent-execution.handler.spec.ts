import { describe, expect, it, jest } from '@jest/globals';
import { UnrecoverableError, type Job } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { AgentConfigurationError } from '../agent-configuration.error';
import { AgentDefinitionRegistry } from '../agent-definition.registry';
import {
  AgentExecutionHandler,
  type AgentExecutionJob,
} from '../agent-execution.handler';
import type { AgentRunService } from '../agent-run.service';
import { AgentRunner } from '../agent-runner.service';
import type {
  AgentDefinition,
  AgentOutputContract,
  AgentRun,
} from '../agent.types';

const run: AgentRun = {
  id: 'run-1',
  agentId: 'test-agent',
  agentVersion: 1,
  organizationAgentVersionId: null,
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

  /**
   * A failure a retry cannot fix — an `AgentRun` pinned to a definition this
   * deployment does not carry, or one whose persisted runtime disagrees with
   * it. The third attempt resolves the same registry as the first, so the only
   * thing the budget buys is a longer delay before somebody is told.
   */
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

      // Attempt one of three: an ordinary failure here would be non-final.
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

    // BullMQ copies the rejection's message into the job's durable
    // `failedReason`, so the registry's own text must not reach it.
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

      // Everything persisted and rethrown is the same constant, so without the
      // code a missing definition and a provider timeout are indistinguishable.
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

    /**
     * The identifying fields are application-owned columns, never anything read
     * off the caught error. A registry message that reached the log would be
     * one an untrusted runtime could have authored.
     */
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

    /**
     * The pairing that makes stopping the retries safe, and the reason the
     * throw is conditional rather than automatic.
     *
     * A lost claim means a newer delivery of this job is executing right now
     * and owns the run. `UnrecoverableError` from this stale delivery would
     * terminally fail the job on that delivery's behalf, ending work that is
     * still running — so a delivery that wrote nothing rejects like any other
     * failure and lets BullMQ's own lock arbitrate.
     */
    it('rejects retryably when it no longer owns the run it would have failed', async () => {
      const { handler, runner, runs } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(run);
      runner.run.mockRejectedValue(registryError());
      // The CAS matched nothing: a newer delivery holds the attempt.
      runs.recordExecutionFailure.mockResolvedValue(false);

      const error = await handler.handle(job(0, 3)).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect((error as Error).name).toBe('Error');
      expect((error as Error).message).toBe('Agent execution failed');
    });

    // A failed durable write outranks the classification: the fact worth
    // reporting is that this delivery no longer owns the run.
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

    /**
     * Why classification is `instanceof` and never the error's own fields.
     *
     * `name` and `message` are attacker-shaped: a model provider, a tool
     * response or a compromised dependency can produce either. If the handler
     * read them, a failing provider could talk the worker out of its retries by
     * naming its error well — every transient outage would become a terminal
     * run. Only code in this repository can construct the class, so identity is
     * the one signal a provider cannot forge.
     */
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
      // Attempt one of three still has budget, and a forged name must not
      // consume it.
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

/**
 * The two halves wired together, because each is green while the seam is wrong.
 *
 * `agent-runner.spec.ts` proves a contract violation is not an
 * `AgentConfigurationError`; the block above proves the handler keeps an
 * ordinary failure retryable. Neither says what happens to a *contract
 * violation* at the handler — and that is the claim that costs money: classified
 * as deterministic it becomes final on first sight, and a model that would have
 * counted correctly on attempt two never gets one.
 *
 * So this composes the real `AgentRunner` with a definition that carries a
 * contract, and asserts the outcome the worker actually produces.
 */
describe('a declared output contract violation, through the worker', () => {
  const contractedDefinition = {
    id: 'test-agent',
    version: 1,
    runtime: 'mastra',
    instructions: 'Answer test requests.',
    model: 'test/provider-model',
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

  /** The real runner, a stub runtime, and no context policy to assemble. */
  const realRunner = (providerOutput: unknown) =>
    new AgentRunner(
      new AgentDefinitionRegistry([contractedDefinition]),
      {
        resolve: jest.fn(() => ({
          name: 'mastra',
          run: () => Promise.resolve({ output: providerOutput as never }),
        })),
      } as never,
      { assemble: () => Promise.resolve([]) } as never,
      { configurationFor: () => Promise.resolve(null) } as never,
    );

  const contractedRun: AgentRun = { ...run, input: { wanted: 3 } };

  it('is retried rather than made final, and named as its own reason', async () => {
    const { runs, warn } = harness();
    runs.claimExecutionAttempt.mockResolvedValue(contractedRun);
    runs.recordExecutionFailure.mockResolvedValue(true);

    const handlerWithRealRunner = new AgentExecutionHandler(
      runs as unknown as AgentRunService,
      realRunner({ items: ['only', 'two'] }),
      { warn } as unknown as PinoLogger,
    );

    const error = await handlerWithRealRunner
      .handle(job(0, 3))
      .catch((thrown: unknown) => thrown);

    // Not final: the budget exists for conditions that can change, and a
    // miscount is one.
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
      contractedRun.id,
      contractedRun.attemptCount,
      'Agent execution failed',
      false,
    );
    /**
     * `contract_violation`, not `runtime_error`. Every attempt writes and
     * rethrows the same constant, so this word is the only thing that tells an
     * operator a model has started miscounting rather than a provider having
     * gone down — and the two have different remedies. It is still retried:
     * naming the failure and classifying it are separate decisions.
     */
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'contract_violation', final: false }),
      expect.any(String),
    );

    // And nothing about the violation itself reached the durable column, the
    // log, or the value BullMQ records as `failedReason` — the reason is one of
    // the handler's own literals, not the error's message.
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
      runs as unknown as AgentRunService,
      realRunner({ items: ['a', 'b', 'c'] }),
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
