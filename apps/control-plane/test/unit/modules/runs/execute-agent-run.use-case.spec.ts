import { describe, expect, it, jest } from '@jest/globals';

import type { AgentRun } from '../../../../src/ai/agents/agent.types';
import { AgentConfigurationError } from '../../../../src/ai/agents/agent-configuration.error';
import { AgentOutputContractError } from '../../../../src/ai/execution/agent-output-contract.error';
import type { AgentRunService } from '../../../../src/ai/execution/agent-run.service';
import type { AgentRunner } from '../../../../src/ai/execution/agent-runner.service';
import { ExecuteAgentRunUseCase } from '../../../../src/modules/runs';

const claimed: AgentRun = {
  id: 'run-1',
  agentId: 'test-agent',
  agentVersion: 4,
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
  attemptCount: 2,
  idempotencyKey: 'request-1',
  startedAt: new Date('2026-09-01T00:00:00.000Z'),
  completedAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
};

function harness() {
  const claimExecutionAttempt =
    jest.fn<(runId: string, attempt: number) => Promise<AgentRun | null>>();
  const markExecutionSucceeded =
    jest.fn<
      (runId: string, attemptCount: number, output: unknown) => Promise<boolean>
    >();
  const recordExecutionFailure =
    jest.fn<
      (
        runId: string,
        attemptCount: number,
        diagnostic: string,
        final: boolean,
      ) => Promise<boolean>
    >();
  const run = jest.fn<(value: AgentRun) => Promise<{ output: unknown }>>();

  const runs = {
    claimExecutionAttempt,
    markExecutionSucceeded,
    recordExecutionFailure,
  };

  const useCase = new ExecuteAgentRunUseCase(
    runs as unknown as AgentRunService,
    { run } as unknown as AgentRunner,
  );

  return { useCase, runs, run };
}

const delivery = (
  overrides: Partial<{ attempt: number; lastDelivery: boolean }> = {},
) => ({
  runId: claimed.id,
  attempt: 2,
  lastDelivery: false,
  ...overrides,
});

describe('ExecuteAgentRunUseCase', () => {
  it('refuses a delivery that names no run', async () => {
    const { useCase, runs } = harness();

    await expect(useCase.execute({ ...delivery(), runId: '' })).rejects.toThrow(
      'Agent execution job requires a runId',
    );
    expect(runs.claimExecutionAttempt).not.toHaveBeenCalled();
  });

  it('claims with the delivery ordinal it was given, and nothing else', async () => {
    const { useCase, runs } = harness();
    runs.claimExecutionAttempt.mockResolvedValue(claimed);
    runs.markExecutionSucceeded.mockResolvedValue(true);

    await useCase.execute(delivery({ attempt: 7 }));

    expect(runs.claimExecutionAttempt).toHaveBeenCalledWith('run-1', 7);
    expect(runs.claimExecutionAttempt).toHaveBeenCalledTimes(1);
  });

  describe('a delivery that holds no claim', () => {
    it('does no work and reports the run it could not take', async () => {
      const { useCase, runs, run } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(null);

      await expect(useCase.execute(delivery())).resolves.toEqual({
        status: 'not_claimed',
        runId: 'run-1',
      });

      expect(run).not.toHaveBeenCalled();
      expect(runs.markExecutionSucceeded).not.toHaveBeenCalled();
      expect(runs.recordExecutionFailure).not.toHaveBeenCalled();
    });
  });

  describe('a successful attempt', () => {
    it('records the output against the attempt it claimed', async () => {
      const { useCase, runs, run } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(claimed);
      run.mockResolvedValue({ output: 'answer' });
      runs.markExecutionSucceeded.mockResolvedValue(true);

      await expect(useCase.execute(delivery())).resolves.toEqual({
        status: 'succeeded',
        run: {
          runId: 'run-1',
          agentId: 'test-agent',
          agentVersion: 4,
          attemptCount: 2,
        },
      });

      expect(runs.markExecutionSucceeded).toHaveBeenCalledWith(
        'run-1',
        2,
        'answer',
      );
    });

    it('writes nothing when a newer attempt already owns the run', async () => {
      const { useCase, runs, run } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(claimed);
      run.mockResolvedValue({ output: 'answer' });
      runs.markExecutionSucceeded.mockResolvedValue(false);

      await expect(useCase.execute(delivery())).resolves.toMatchObject({
        status: 'claim_lost',
        diagnostic: 'Agent execution failed',
      });

      expect(runs.recordExecutionFailure).not.toHaveBeenCalled();
    });

    it('separates a lost claim from a result write that failed outright', async () => {
      const { useCase, runs, run } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(claimed);
      run.mockResolvedValue({ output: 'answer' });
      runs.markExecutionSucceeded.mockRejectedValue(
        new Error('connection lost'),
      );

      await expect(useCase.execute(delivery())).resolves.toMatchObject({
        status: 'result_unrecorded',
      });
    });
  });

  describe('a failed attempt', () => {
    it('is not final while the caller still has a delivery left', async () => {
      const { useCase, runs, run } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(claimed);
      run.mockRejectedValue(new Error('provider timed out'));
      runs.recordExecutionFailure.mockResolvedValue(true);

      await expect(
        useCase.execute(delivery({ lastDelivery: false })),
      ).resolves.toMatchObject({
        status: 'failed',
        reason: 'runtime_error',
        final: false,
        exhausted: false,
      });

      expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
        'run-1',
        2,
        'Agent execution failed',
        false,
      );
    });

    it('is final once the caller says this was the last delivery', async () => {
      const { useCase, runs, run } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(claimed);
      run.mockRejectedValue(new Error('provider timed out'));
      runs.recordExecutionFailure.mockResolvedValue(true);

      await expect(
        useCase.execute(delivery({ lastDelivery: true })),
      ).resolves.toMatchObject({ final: true, exhausted: false });

      expect(runs.recordExecutionFailure).toHaveBeenCalledWith(
        'run-1',
        2,
        'Agent execution failed',
        true,
      );
    });

    it('is final on the first attempt when the cause cannot change', async () => {
      const { useCase, runs, run } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(claimed);
      run.mockRejectedValue(new AgentConfigurationError('mismatched runtime'));
      runs.recordExecutionFailure.mockResolvedValue(true);

      await expect(
        useCase.execute(delivery({ lastDelivery: false })),
      ).resolves.toMatchObject({
        status: 'failed',
        reason: 'configuration_error',
        final: true,
        exhausted: true,
      });
    });

    it('keeps a deterministic failure retryable when the record did not land', async () => {
      const { useCase, runs, run } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(claimed);
      run.mockRejectedValue(new AgentConfigurationError('mismatched runtime'));
      runs.recordExecutionFailure.mockResolvedValue(false);

      await expect(useCase.execute(delivery())).resolves.toMatchObject({
        status: 'failed',
        reason: 'claim_lost',
        exhausted: false,
      });
    });

    it('names a broken output contract as its own cause, and keeps retrying', async () => {
      const { useCase, runs, run } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(claimed);
      run.mockRejectedValue(
        new AgentOutputContractError({
          code: 'count_mismatch',
          expected: 3,
          received: 2,
        }),
      );
      runs.recordExecutionFailure.mockResolvedValue(true);

      await expect(useCase.execute(delivery())).resolves.toMatchObject({
        status: 'failed',
        reason: 'contract_violation',
        final: false,
        exhausted: false,
      });
    });

    it('never carries a provider message into its outcome', async () => {
      const { useCase, runs, run } = harness();
      runs.claimExecutionAttempt.mockResolvedValue(claimed);
      run.mockRejectedValue(
        new Error('429 from provider: key sk-live-abcdef exhausted'),
      );
      runs.recordExecutionFailure.mockResolvedValue(true);

      const outcome = await useCase.execute(delivery());

      expect(JSON.stringify(outcome)).not.toContain('sk-live');
      expect(JSON.stringify(outcome)).not.toContain('429');
    });
  });
});
