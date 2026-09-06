import { describe, expect, it, jest } from '@jest/globals';

import type { ToolAuthorizationService } from '../../../../src/ai/tools/tool-authorization.service';
import type {
  SideEffectExecutionRow,
  ToolExecutionService,
} from '../../../../src/ai/tools/tool-execution.service';
import {
  SideEffectPreconditionError,
  type PreparedEffect,
  type SideEffectDeliveryCommand,
  type SideEffectDeliveryPort,
  type SideEffectPreparer,
  type ToolFailureCode,
} from '../../../../src/ai/tools/tool.types';
import { NotificationSideEffectDeliveryAdapter } from '../../../../src/features/agent-management/tools/notification-side-effect-delivery.adapter';
import type { NotificationDelivery } from '../../../../src/infrastructure/mail/notification-delivery.port';
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

const defaultCommandPayload: SideEffectDeliveryCommand = {
  tool: 'notification.send@1',
  payloadDigest: 'digest-a',
  payload: {
    to: 'sara@example.com',
    subject: 'Handoff ready',
    text: 'Please review the draft.',
    html: '<p>Please review the draft.</p>',
  },
};

function harness(
  authorization: Partial<{
    authorize: jest.Mock<ToolAuthorizationService['authorize']>;
  }> = {},
  deliveryOverrides: Partial<{
    deliver: jest.Mock<SideEffectDeliveryPort['deliver']>;
  }> = {},
  preparerOverrides: Partial<{
    prepareEffect: jest.Mock<SideEffectPreparer['prepareEffect']>;
  }> = {},
) {
  const delivery = {
    deliver:
      deliveryOverrides.deliver ??
      jest.fn<SideEffectDeliveryPort['deliver']>(() =>
        Promise.resolve({
          kind: 'accepted',
          providerMessageId: 'msg_1',
        } as const),
      ),
  };

  const prepareEffect =
    preparerOverrides.prepareEffect ??
    jest.fn<SideEffectPreparer['prepareEffect']>(() =>
      Promise.resolve({
        payloadDigest: 'digest-a',
        command: defaultCommandPayload,
      }),
    );

  const preparer: SideEffectPreparer = {
    ref: 'notification.send@1',
    prepareEffect,
  };

  const authorize =
    authorization.authorize ??
    jest.fn<ToolAuthorizationService['authorize']>(() =>
      Promise.resolve({
        ref: 'notification.send@1',
        preparer,
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
    delivery,
  );

  return {
    useCase,
    executions,
    authorize,
    prepareEffect,
    deliver: delivery.deliver,
    delivery,
    commandPayload: defaultCommandPayload,
  };
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

  it('asks authorization before it can prepare or deliver the effect', async () => {
    const { useCase, authorize, prepareEffect, deliver } = harness();

    await useCase.execute(command);

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(
      prepareEffect.mock.invocationCallOrder[0],
    );
    expect(prepareEffect.mock.invocationCallOrder[0]).toBeLessThan(
      deliver.mock.invocationCallOrder[0],
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

  it('hands the provider delivery port an authorized data command and stable idempotency identity', async () => {
    const { useCase, deliver, commandPayload } = harness();

    await useCase.execute(command);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      commandPayload,
      'notification.send@1:exec_1',
    );
    expect(typeof deliver.mock.calls[0][1]).toBe('string');
  });

  it('ensures prepared effect and delivery command are function-free serializable data', async () => {
    const { useCase, prepareEffect } = harness();

    await useCase.execute(command);

    const prepared = (await prepareEffect.mock.results[0]
      .value) as PreparedEffect;

    expect(prepared).toBeDefined();
    // Prepared effect contains no deliver function or closures
    expect(typeof (prepared as unknown as { deliver?: unknown }).deliver).toBe(
      'undefined',
    );
    expect(typeof prepared.command).toBe('object');
    // Command contains no executable functions
    for (const key of Object.keys(prepared.command)) {
      expect(
        typeof prepared.command[key as keyof typeof prepared.command],
      ).not.toBe('function');
    }
    // Command is pure JSON serializable data
    expect(JSON.parse(JSON.stringify(prepared.command))).toEqual(
      prepared.command,
    );
    // Command carries no durable authority objects
    expect(prepared.command).not.toHaveProperty('definition');
    expect(prepared.command).not.toHaveProperty('approval');
    expect(prepared.command).not.toHaveProperty('organization');
    expect(prepared.command).not.toHaveProperty('status');
  });

  it('ensures delivery adapter does not require or receive durable authority', async () => {
    const mailDeliver = jest.fn<NotificationDelivery['deliver']>(() =>
      Promise.resolve({
        kind: 'accepted' as const,
        providerMessageId: 'prov_1',
      }),
    );
    const mockMailDelivery: NotificationDelivery = {
      idempotent: true,
      sender: 'Acme <no-reply@example.test>',
      deliver: mailDeliver,
    };

    // Delivery adapter has no dependency on PrismaService, approvals, or AgentDefinition
    const adapter = new NotificationSideEffectDeliveryAdapter(mockMailDelivery);

    const outcome = await adapter.deliver(
      defaultCommandPayload,
      'notification.send@1:exec_1',
    );

    expect(outcome).toEqual({ kind: 'accepted', providerMessageId: 'prov_1' });
    expect(mailDeliver).toHaveBeenCalledWith({
      to: defaultCommandPayload.payload.to,
      subject: defaultCommandPayload.payload.subject,
      text: defaultCommandPayload.payload.text,
      html: defaultCommandPayload.payload.html,
      idempotencyKey: 'notification.send@1:exec_1',
    });
  });

  it('keeps recipient resolution in CP preparation before provider boundary', async () => {
    const prepareEffect = jest.fn<SideEffectPreparer['prepareEffect']>(() =>
      Promise.reject(new SideEffectPreconditionError('precondition_recipient')),
    );
    const { useCase, deliver, executions } = harness({}, {}, { prepareEffect });

    await useCase.execute(command);

    expect(prepareEffect).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(executions.settleEffect).toHaveBeenCalledWith('exec_1', 'org_1', {
      status: 'FAILED',
      failureCode: 'precondition_recipient',
    });
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
