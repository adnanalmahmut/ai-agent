import { describe, expect, it, jest } from '@jest/globals';

import type { ToolAuthorizationService } from '../../../../src/ai/tools/tool-authorization.service';
import type {
  SideEffectExecutionRow,
  ToolExecutionService,
} from '../../../../src/ai/tools/tool-execution.service';
import type {
  PreparedEffect,
  SideEffectToolImplementation,
  ToolFailureCode,
} from '../../../../src/ai/tools/tool.types';
import { DeliverApprovedToolEffectUseCase } from '../../../../src/modules/approvals';

const row = (
  overrides: Partial<SideEffectExecutionRow> = {},
): SideEffectExecutionRow => ({
  id: 'exec_1',
  organizationId: 'org_1',
  agentRunId: 'run_1',
  agentRunAttempt: 1,
  toolId: 'notification.send',
  toolVersion: 1,
  status: 'APPROVED',
  input: { to: 'someone' },
  effectAttemptCount: 0,
  effectFirstAttemptedAt: null,
  effectPayloadDigest: null,
  approval: { status: 'APPROVED', inputDigest: 'digest' },
  agentRun: {
    agentId: 'approval-agent',
    agentVersion: 1,
    organizationAgentVersionId: 'orgver_1',
  },
  ...overrides,
});

function harness(
  authorization: Partial<{
    authorize: jest.Mock<ToolAuthorizationService['authorize']>;
  }> = {},
) {
  const deliver = jest.fn<PreparedEffect['deliver']>(() =>
    Promise.resolve({ kind: 'accepted', providerMessageId: 'msg_1' } as const),
  );
  const prepareEffect = jest.fn<SideEffectToolImplementation['prepareEffect']>(
    () => Promise.resolve({ payloadDigest: 'digest-a', deliver }),
  );
  const implementation = {
    ref: 'notification.send@1',
    kind: 'side_effect',
    propose: () => Promise.resolve(),
    prepareEffect,
  } as SideEffectToolImplementation;

  const authorize =
    authorization.authorize ??
    jest.fn<ToolAuthorizationService['authorize']>(() =>
      Promise.resolve({
        ref: 'notification.send@1',
        implementation,
        definition: {} as never,
      }),
    );

  const executions = {
    loadSideEffect: jest.fn<ToolExecutionService['loadSideEffect']>(() =>
      Promise.resolve(row()),
    ),
    claimEffectAttempt: jest.fn<ToolExecutionService['claimEffectAttempt']>(
      () => Promise.resolve(true),
    ),
    settleEffect: jest.fn<ToolExecutionService['settleEffect']>(() =>
      Promise.resolve(true),
    ),
  };

  const useCase = new DeliverApprovedToolEffectUseCase(
    executions as unknown as ToolExecutionService,
    { authorize } as unknown as ToolAuthorizationService,
  );

  return { useCase, executions, authorize, prepareEffect, deliver };
}

const command = {
  toolExecutionId: 'exec_1',
  organizationId: 'org_1',
  lastDelivery: false,
};

describe('what stands between an approval and a provider', () => {
  const refusals: ToolFailureCode[] = [
    'precondition_organization',
    'precondition_approval',
    'precondition_authority',
  ];

  it.each(refusals)(
    'prepares nothing and sends nothing when authorization answers %s',
    async (refusal) => {
      const authorize = jest.fn<ToolAuthorizationService['authorize']>(() =>
        Promise.resolve({ refusal }),
      );
      const { useCase, prepareEffect, deliver, executions } = harness({
        authorize,
      });

      await useCase.execute(command);

      expect(prepareEffect).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(executions.claimEffectAttempt).not.toHaveBeenCalled();
      expect(executions.settleEffect).toHaveBeenCalledWith('exec_1', 'org_1', {
        status: 'FAILED',
        failureCode: refusal,
      });
    },
  );

  it('asks authorization before it can name a tool implementation at all', async () => {
    const { useCase, authorize, prepareEffect } = harness();

    await useCase.execute(command);

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(
      prepareEffect.mock.invocationCallOrder[0],
    );
  });

  it('authorizes against the stored row, not against anything a caller sent', async () => {
    const stored = row();
    const { useCase, authorize, executions } = harness();
    executions.loadSideEffect.mockResolvedValue(stored);

    await useCase.execute({
      ...command,
      // A caller inventing extra fields cannot smuggle them into the decision.
      ...({ approved: true, toolGrants: ['notification.send@1'] } as object),
    });

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0][0]).toBe(stored);
  });

  it('never sends for a row that is still awaiting approval', async () => {
    const { useCase, executions, authorize, deliver } = harness();
    executions.loadSideEffect.mockResolvedValue(
      row({ status: 'AWAITING_APPROVAL' }),
    );

    await expect(
      useCase.execute({ ...command, ...({ approved: true } as object) }),
    ).resolves.toMatchObject({ status: 'complete' });

    expect(authorize).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(executions.settleEffect).not.toHaveBeenCalled();
  });

  it('hands the provider adapter one idempotency key and nothing else', async () => {
    const { useCase, deliver } = harness();

    await useCase.execute(command);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]).toEqual(['notification.send@1:exec_1']);
    expect(typeof deliver.mock.calls[0][0]).toBe('string');
  });

  it('claims the attempt before the effect leaves the process', async () => {
    const { useCase, executions, deliver } = harness();

    await useCase.execute(command);

    expect(
      executions.claimEffectAttempt.mock.invocationCallOrder[0],
    ).toBeLessThan(deliver.mock.invocationCallOrder[0]);
  });

  it('does not send when the claim is already held elsewhere', async () => {
    const { useCase, executions, deliver } = harness();
    executions.claimEffectAttempt.mockResolvedValue(false);

    await expect(useCase.execute(command)).resolves.toMatchObject({
      status: 'retry',
    });

    expect(deliver).not.toHaveBeenCalled();
  });

  it('comes back rather than settling when authorization itself cannot be reached', async () => {
    const authorize = jest.fn<ToolAuthorizationService['authorize']>(() =>
      Promise.reject(new Error('connection refused')),
    );
    const { useCase, executions, deliver } = harness({ authorize });

    await expect(useCase.execute(command)).resolves.toMatchObject({
      status: 'retry',
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(executions.settleEffect).not.toHaveBeenCalled();
  });

  it('records an unanswered provider as unknown once no delivery remains', async () => {
    const { useCase, executions, deliver } = harness();
    deliver.mockResolvedValue({ kind: 'unavailable' });

    await expect(
      useCase.execute({ ...command, lastDelivery: true }),
    ).resolves.toMatchObject({ status: 'complete' });

    expect(executions.settleEffect).toHaveBeenCalledWith('exec_1', 'org_1', {
      status: 'OUTCOME_UNKNOWN',
    });
  });

  it('keeps an unanswered provider open while a delivery remains', async () => {
    const { useCase, executions, deliver } = harness();
    deliver.mockResolvedValue({ kind: 'unavailable' });

    await expect(
      useCase.execute({ ...command, lastDelivery: false }),
    ).resolves.toMatchObject({ status: 'retry' });

    expect(executions.settleEffect).not.toHaveBeenCalled();
  });

  it('treats a rejection by the provider as a settled failure, not an unknown', async () => {
    const { useCase, executions, deliver } = harness();
    deliver.mockResolvedValue({ kind: 'rejected' });

    await useCase.execute(command);

    expect(executions.settleEffect).toHaveBeenCalledWith('exec_1', 'org_1', {
      status: 'FAILED',
      failureCode: 'provider_rejected',
    });
  });

  it('refuses to say a second attempt failed cleanly once one has gone out', async () => {
    const { useCase, executions, deliver } = harness();
    executions.loadSideEffect.mockResolvedValue(
      row({ effectAttemptCount: 1, effectPayloadDigest: 'digest-a' }),
    );
    deliver.mockResolvedValue({ kind: 'rejected' });

    await useCase.execute(command);

    expect(executions.settleEffect).toHaveBeenCalledWith('exec_1', 'org_1', {
      status: 'OUTCOME_UNKNOWN',
    });
  });

  it('reports what it decided without naming a provider or a queue', async () => {
    const { useCase, deliver } = harness();
    deliver.mockResolvedValue({ kind: 'rejected' });

    const outcome = await useCase.execute(command);
    const serialized = JSON.stringify(outcome);

    expect(outcome.records.length).toBeGreaterThan(0);
    for (const term of ['attemptsMade', 'attemptsStarted', 'job', 'bullmq']) {
      expect(serialized).not.toContain(term);
    }
  });
});
