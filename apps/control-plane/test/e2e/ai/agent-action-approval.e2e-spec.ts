import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';

import { AgentDefinitionRegistry } from '../../../src/ai/agents/agent-definition.registry';
import { OrganizationAgentInstallationService } from '../../../src/features/agent-management/organization-agent-installation.service';
import type { AgentDefinition } from '../../../src/ai/agents/agent.types';
import { APPLICATION_TOOL_DEFINITIONS } from '../../../src/features/agent-management/tools/definitions';
import { NotificationSendTool } from '../../../src/features/agent-management/tools/notification-send.tool';
import {
  SideEffectExecutionHandler,
  type SideEffectExecutionJob,
} from '../../../src/workers/handlers/side-effect-execution.handler';
import {
  DeliverApprovedToolEffectUseCase,
  EFFECT_RETRY_WINDOW_MS,
  idempotencyKeyFor,
} from '../../../src/modules/approvals';
import { ToolAuthorizationService } from '../../../src/ai/tools/tool-authorization.service';
import { ToolExecutionService } from '../../../src/ai/tools/tool-execution.service';
import {
  ToolExecutionFailure,
  ToolGateway,
} from '../../../src/ai/tools/tool.gateway';
import { ToolRegistry } from '../../../src/ai/tools/tool.registry';
import type {
  ExternalEffectOutcome,
  NotificationDelivery,
  NotificationMessage,
} from '../../../src/infrastructure/mail/notification-delivery.port';
import { MODEL_IDS } from '../../../src/ai/models/model-catalog';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

const AGENT_ID = 'approval-only-agent';
const KNOWLEDGE_REF = 'knowledge.search@1' as const;
const REF = 'notification.send@1';

const approvalAgent = (maxToolGrants: readonly string[]): AgentDefinition => ({
  id: AGENT_ID,
  version: 1,
  runtime: 'mastra',
  instructions: 'Propose a notification.',
  model: MODEL_IDS.openAiGpt4oMini,
  modelPolicy: {
    id: `${AGENT_ID}.model-policy.1`,
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  input: z.unknown(),
  output: z.unknown(),
  organizationConfiguration: {
    schema: z.object({}).strict(),
    defaultValue: {},
  },
  maxToolGrants: maxToolGrants as never,
});

const DEFINITIONS = [approvalAgent([KNOWLEDGE_REF, REF])] as const;

const providerIdFor = (key: string) =>
  `msg_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;

class RecordingDelivery implements NotificationDelivery {
  readonly idempotent = true;
  readonly sender = 'Acme <no-reply@example.test>';
  readonly calls: NotificationMessage[] = [];
  answer: (message: NotificationMessage) => Promise<ExternalEffectOutcome> = (
    message,
  ) =>
    Promise.resolve({
      kind: 'accepted',
      providerMessageId: providerIdFor(message.idempotencyKey),
    });

  deliver(message: NotificationMessage): Promise<ExternalEffectOutcome> {
    this.calls.push(message);
    return this.answer(message);
  }

  reset(): void {
    this.calls.length = 0;
    this.answer = (message) =>
      Promise.resolve({
        kind: 'accepted',
        providerMessageId: providerIdFor(message.idempotencyKey),
      });
  }
}

const silentLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const job = (
  toolExecutionId: string,
  organizationId: string,
  overrides: { attemptsMade?: number; attempts?: number } = {},
) =>
  ({
    data: { toolExecutionId, organizationId },
    opts: { attempts: overrides.attempts ?? 3 },
    attemptsMade: overrides.attemptsMade ?? 0,
    attemptsStarted: (overrides.attemptsMade ?? 0) + 1,
  }) as unknown as Job<SideEffectExecutionJob>;

describe('human approval and the idempotent side effect', () => {
  let harness: Harness;
  let owner: TestUser;
  let orgAdmin: TestUser;
  let member: TestUser;
  let recipient: TestUser;
  let outsider: TestUser;
  let platformAdmin: TestUser;
  let organizationId: string;
  let otherOrganizationId: string;
  let recipientMemberId: string;
  let versionId: string;

  let executions: ToolExecutionService;
  let delivery: RecordingDelivery;
  let tool: NotificationSendTool;
  let gateway: ToolGateway;
  let handler: SideEffectExecutionHandler;

  const ownedOrganizationIds: string[] = [];

  const base = (org = organizationId) =>
    `/organizations/${org}/agent-action-approvals`;

  const createOrganization = async (user: TestUser, name: string) => {
    const response = await as(harness, user).post(
      '/api/auth/organization/create',
      { name, slug: `${name}-${Date.now().toString(36)}` },
    );
    expect(response.status).toBe(200);
    const id = (response.body as { id: string }).id;
    ownedOrganizationIds.push(id);
    return id;
  };

  const addMember = async (
    invitee: TestUser,
    role: string,
    org = organizationId,
  ) => {
    const invite = await as(harness, owner).post(
      '/api/auth/organization/invite-member',
      { email: invitee.email, role, organizationId: org },
    );
    expect(invite.status).toBe(200);

    const accepted = await as(harness, invitee).post(
      '/api/auth/organization/accept-invitation',
      { invitationId: (invite.body as { id: string }).id },
    );
    expect(accepted.status).toBe(200);
  };

  const memberIdOf = async (userId: string, org = organizationId) =>
    (
      await harness.prisma.member.findFirstOrThrow({
        where: { userId, organizationId: org },
        select: { id: true },
      })
    ).id;

  const acceptedRun = async (
    org = organizationId,
    pinnedVersionId = versionId,
  ) =>
    harness.prisma.agentRun.create({
      data: {
        agentId: AGENT_ID,
        agentVersion: 1,
        runtime: 'mastra',
        status: 'SUCCEEDED',
        organizationId: org,
        organizationAgentVersionId: pinnedVersionId,
        input: { ask: 'notify' },
        attemptCount: 1,
        idempotencyKey: `approval-${Math.random().toString(36).slice(2)}`,
      },
      select: { id: true },
    });

  const propose = async (
    input: { recipientMemberId?: string; subject?: string; body?: string } = {},
    org = organizationId,
    pinnedVersionId = versionId,
  ) => {
    const run = await acceptedRun(org, pinnedVersionId);
    const [exposed] = gateway.authorize({
      definition: DEFINITIONS[0],
      organizationId: org,
      agentRunId: run.id,
      agentRunAttempt: 1,
      grants: [REF],
    });

    await expect(
      exposed.execute({
        recipientMemberId: recipientMemberId,
        subject: 'Handoff ready',
        body: 'Please review the draft.',
        ...input,
      }),
    ).resolves.toEqual({ status: 'awaiting_approval' });

    const execution = await harness.prisma.toolExecution.findFirstOrThrow({
      where: { agentRunId: run.id },
      select: { id: true },
    });

    return { executionId: execution.id, runId: run.id };
  };

  const execution = (id: string) =>
    harness.prisma.toolExecution.findUniqueOrThrow({
      where: { id },
      include: { approval: true },
    });

  beforeAll(async () => {
    harness = await createHarness();
    executions = new ToolExecutionService(harness.prisma);
    delivery = new RecordingDelivery();
    tool = new NotificationSendTool(harness.prisma, delivery);

    const registry = new ToolRegistry(APPLICATION_TOOL_DEFINITIONS);
    const implementations = [
      { ref: KNOWLEDGE_REF, execute: () => Promise.resolve({ passages: [] }) },
      tool,
    ];
    gateway = new ToolGateway(registry, executions, implementations);
    handler = new SideEffectExecutionHandler(
      new DeliverApprovedToolEffectUseCase(
        executions,
        new ToolAuthorizationService(
          harness.prisma,
          registry,
          new AgentDefinitionRegistry(DEFINITIONS),
          implementations,
        ),
      ),
      silentLogger as never,
    );

    owner = await createUser(harness);
    orgAdmin = await createUser(harness);
    member = await createUser(harness);
    recipient = await createUser(harness);
    outsider = await createUser(harness);
    platformAdmin = await createUser(harness, { role: 'admin' });

    organizationId = await createOrganization(owner, 'approvals-acme');
    otherOrganizationId = await createOrganization(outsider, 'approvals-other');

    await addMember(orgAdmin, 'admin');
    await addMember(member, 'member');
    await addMember(recipient, 'member');
    recipientMemberId = await memberIdOf(recipient.id);

    const installations = new OrganizationAgentInstallationService(
      harness.prisma,
      new AgentDefinitionRegistry(DEFINITIONS),
    );
    const installed = await installations.create(
      organizationId,
      {
        agentId: AGENT_ID,
        definitionVersion: 1,
        enabled: true,
        toolGrants: [REF] as never,
      },
      owner.id,
    );
    versionId = installed.activeVersionId;
  });

  afterAll(async () => {
    try {
      for (const id of ownedOrganizationIds) {
        await harness.prisma.toolExecutionApproval.deleteMany({
          where: { organizationId: id },
        });
        const rows = await harness.prisma.toolExecution.findMany({
          where: { organizationId: id },
          select: { id: true },
        });
        await harness.prisma.outboxEvent.deleteMany({
          where: { dedupeKey: { in: rows.map((row) => row.id) } },
        });
        await harness.prisma.toolExecution.deleteMany({
          where: { organizationId: id },
        });
        await harness.prisma.agentRun.deleteMany({
          where: { organizationId: id },
        });
      }
    } finally {
      await harness.close();
    }
  });

  describe('the proposal', () => {
    it('records AWAITING_APPROVAL and a PENDING approval, and sends nothing', async () => {
      delivery.reset();
      const { executionId, runId } = await propose();

      const row = await execution(executionId);

      expect(row).toMatchObject({
        organizationId,
        agentRunId: runId,
        toolId: 'notification.send',
        toolVersion: 1,
        status: 'AWAITING_APPROVAL',
        input: {
          recipientMemberId,
          subject: 'Handoff ready',
          body: 'Please review the draft.',
        },
        effectAttemptCount: 0,
        providerMessageId: null,
      });
      expect(row.approval).toMatchObject({
        organizationId,
        status: 'PENDING',
        decidedAt: null,
        decidedByUserId: null,
      });
      expect(row.approval?.inputDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(delivery.calls).toEqual([]);
    });

    it('refuses a recipient who is not a member of this organization, writing nothing', async () => {
      const foreignMemberId = await memberIdOf(
        outsider.id,
        otherOrganizationId,
      );
      const run = await acceptedRun();
      const [exposed] = gateway.authorize({
        definition: DEFINITIONS[0],
        organizationId,
        agentRunId: run.id,
        agentRunAttempt: 1,
        grants: [REF],
      });

      const failure = await exposed
        .execute({
          recipientMemberId: foreignMemberId,
          subject: 'Handoff ready',
          body: 'Please review the draft.',
        })
        .then(
          () => null,
          (error: unknown) => error as Error,
        );

      expect(failure).toBeInstanceOf(ToolExecutionFailure);
      expect(failure?.message).toBe(
        'Tool "notification_send_v1" could not record the proposal',
      );
      expect(
        await harness.prisma.toolExecution.count({
          where: { agentRunId: run.id },
        }),
      ).toBe(0);
    });

    it('refuses an email address where a membership id belongs', async () => {
      const run = await acceptedRun();
      const [exposed] = gateway.authorize({
        definition: DEFINITIONS[0],
        organizationId,
        agentRunId: run.id,
        agentRunAttempt: 1,
        grants: [REF],
      });

      await expect(
        exposed.execute({
          recipientMemberId,
          subject: 'x',
          body: 'y',
          to: 'attacker@example.com',
        }),
      ).rejects.toThrow('received invalid input');
      expect(
        await harness.prisma.toolExecution.count({
          where: { agentRunId: run.id },
        }),
      ).toBe(0);
    });

    it('is not exposed to a run whose version did not select it', async () => {
      const run = await acceptedRun();

      expect(
        gateway
          .authorize({
            definition: DEFINITIONS[0],
            organizationId,
            agentRunId: run.id,
            agentRunAttempt: 1,
            grants: [KNOWLEDGE_REF],
          })
          .map((exposed) => exposed.name),
      ).toEqual(['knowledge_search_v1']);
    });
  });

  describe('authorization', () => {
    let executionId: string;

    beforeAll(async () => {
      ({ executionId } = await propose());
    });

    it('lets a member read what is waiting', async () => {
      const response = await as(harness, member).get(base());

      expect(response.status).toBe(200);
      const items = (
        response.body as { data: { items: { toolExecutionId: string }[] } }
      ).data.items;
      expect(items.some((item) => item.toolExecutionId === executionId)).toBe(
        true,
      );
    });

    it('shows the proposal with the recipient resolved, and no provider detail', async () => {
      const response = await as(harness, member).get(
        `${base()}/${executionId}`,
      );

      expect(response.status).toBe(200);
      const view = (response.body as { data: Record<string, unknown> }).data;

      expect(view).toMatchObject({
        toolExecutionId: executionId,
        toolId: 'notification.send',
        executionStatus: 'AWAITING_APPROVAL',
        approval: { status: 'PENDING' },
        proposal: {
          kind: 'notification.send@1',
          recipient: { memberId: recipientMemberId, email: recipient.email },
          subject: 'Handoff ready',
        },
      });
      expect(JSON.stringify(view)).not.toContain('effectPayloadDigest');
      expect(JSON.stringify(view)).not.toContain('providerMessageId');
      expect(JSON.stringify(view)).not.toContain(
        idempotencyKeyFor({
          id: executionId,
          toolId: 'notification.send',
          toolVersion: 1,
        }),
      );
    });

    it.each(['approve', 'reject'])(
      'refuses a member the decision: %s',
      async (decision) => {
        const response = await as(harness, member).post(
          `${base()}/${executionId}/${decision}`,
        );

        expect(response.status).toBe(403);
        expect(errorBody(response).errorCode).toBe('FORBIDDEN');
        expect((await execution(executionId)).status).toBe('AWAITING_APPROVAL');
      },
    );

    it('does not show another organization the proposal through its own path', async () => {
      const detail = await as(harness, outsider).get(
        `${base(otherOrganizationId)}/${executionId}`,
      );
      expect(detail.status).toBe(404);

      const list = await as(harness, outsider).get(base(otherOrganizationId));
      expect(list.status).toBe(200);
      const items = (
        list.body as { data: { items: { toolExecutionId: string }[] } }
      ).data.items;
      expect(items.some((item) => item.toolExecutionId === executionId)).toBe(
        false,
      );

      const reject = await as(harness, outsider).post(
        `${base(otherOrganizationId)}/${executionId}/reject`,
      );
      expect(reject.status).toBe(404);
      expect((await execution(executionId)).status).toBe('AWAITING_APPROVAL');
    });

    it('answers an outsider as if nothing existed', async () => {
      const read = await as(harness, outsider).get(`${base()}/${executionId}`);
      const decide = await as(harness, outsider).post(
        `${base()}/${executionId}/approve`,
      );

      expect(read.status).toBe(404);
      expect(decide.status).toBe(404);
    });

    it('grants a platform admin nothing inside a tenant', async () => {
      const read = await as(harness, platformAdmin).get(
        `${base()}/${executionId}`,
      );
      const approve = await as(harness, platformAdmin).post(
        `${base()}/${executionId}/approve`,
      );
      const reject = await as(harness, platformAdmin).post(
        `${base()}/${executionId}/reject`,
      );

      expect([read.status, approve.status, reject.status]).toEqual([
        404, 404, 404,
      ]);
      expect((await execution(executionId)).status).toBe('AWAITING_APPROVAL');
    });

    it('does not let another organization decide it through its own path', async () => {
      const response = await as(harness, outsider).post(
        `${base(otherOrganizationId)}/${executionId}/approve`,
      );

      expect(response.status).toBe(404);
      expect((await execution(executionId)).status).toBe('AWAITING_APPROVAL');
    });

    it('lets an organization admin decide', async () => {
      const response = await as(harness, orgAdmin).post(
        `${base()}/${executionId}/reject`,
        { note: 'Not this week.' },
      );

      expect(response.status).toBe(201);
      expect(
        (response.body as { data: Record<string, unknown> }).data,
      ).toMatchObject({
        executionStatus: 'REJECTED',
        approval: {
          status: 'REJECTED',
          decidedByUserId: orgAdmin.id,
          decisionNote: 'Not this week.',
        },
      });
    });

    it('lets an owner decide', async () => {
      const fresh = await propose();
      const response = await as(harness, owner).post(
        `${base()}/${fresh.executionId}/approve`,
      );

      expect(response.status).toBe(201);
      expect((await execution(fresh.executionId)).status).toBe('APPROVED');
    });

    it('refuses a body carrying anything but a note', async () => {
      const fresh = await propose();
      const response = await as(harness, owner).post(
        `${base()}/${fresh.executionId}/approve`,
        { note: 'ok', recipientMemberId: 'someone-else' },
      );

      expect(response.status).toBe(400);
      expect((await execution(fresh.executionId)).status).toBe(
        'AWAITING_APPROVAL',
      );
    });
  });

  describe('the decision', () => {
    it('approves once, commits the outbox event and the audit row together', async () => {
      const { executionId, runId } = await propose();

      const response = await as(harness, owner).post(
        `${base()}/${executionId}/approve`,
        { note: 'Send it.' },
      );
      expect(response.status).toBe(201);

      const row = await execution(executionId);
      expect(row.status).toBe('APPROVED');
      expect(row.approval).toMatchObject({
        status: 'APPROVED',
        decidedByUserId: owner.id,
        decisionNote: 'Send it.',
      });
      expect(row.approval?.decidedAt).not.toBeNull();

      const event = await harness.prisma.outboxEvent.findFirstOrThrow({
        where: { dedupeKey: executionId },
      });
      expect(event).toMatchObject({
        type: 'tool-execution.approved',
        payload: { toolExecutionId: executionId, organizationId },
        status: 'PENDING',
      });

      const audit =
        await harness.prisma.organizationAuditEvent.findFirstOrThrow({
          where: { organizationId, subjectId: executionId },
        });
      expect(audit).toMatchObject({
        action: 'agentActionApproval.approved',
        subjectType: 'toolExecution',
        actorUserId: owner.id,
        before: null,
        after: {
          kind: 'agentActionApproval',
          toolExecutionId: executionId,
          agentRunId: runId,
          toolId: 'notification.send',
          toolVersion: 1,
          decision: 'approved',
        },
      });
      expect(JSON.stringify(audit.after)).not.toContain('Handoff ready');
      expect(JSON.stringify(audit.after)).not.toContain(recipient.email);
    });

    it('refuses a second approval of a decided proposal', async () => {
      const { executionId } = await propose();
      await as(harness, owner)
        .post(`${base()}/${executionId}/approve`)
        .expect(201);

      const second = await as(harness, orgAdmin).post(
        `${base()}/${executionId}/approve`,
      );

      expect(second.status).toBe(409);
      expect(errorBody(second).errorCode).toBe('CONFLICT');
      expect(errorBody(second).error?.details).toEqual({
        kind: 'business',
        reason: 'already_decided',
      });

      const row = await execution(executionId);
      expect(row.approval?.decidedByUserId).toBe(owner.id);
      expect(
        await harness.prisma.outboxEvent.count({
          where: { dedupeKey: executionId },
        }),
      ).toBe(1);
    });

    it('refuses a rejection after an approval and an approval after a rejection', async () => {
      const approved = await propose();
      await as(harness, owner)
        .post(`${base()}/${approved.executionId}/approve`)
        .expect(201);
      const rejectAfter = await as(harness, owner).post(
        `${base()}/${approved.executionId}/reject`,
      );
      expect(rejectAfter.status).toBe(409);
      expect((await execution(approved.executionId)).status).toBe('APPROVED');

      const rejected = await propose();
      await as(harness, owner)
        .post(`${base()}/${rejected.executionId}/reject`)
        .expect(201);
      const approveAfter = await as(harness, owner).post(
        `${base()}/${rejected.executionId}/approve`,
      );
      expect(approveAfter.status).toBe(409);
      expect((await execution(rejected.executionId)).status).toBe('REJECTED');
      expect(
        await harness.prisma.outboxEvent.count({
          where: { dedupeKey: rejected.executionId },
        }),
      ).toBe(0);
    });

    it('lets exactly one of two concurrent approvals through', async () => {
      const { executionId } = await propose();

      const [first, second] = await Promise.all([
        as(harness, owner).post(`${base()}/${executionId}/approve`),
        as(harness, orgAdmin).post(`${base()}/${executionId}/approve`),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect(
        await harness.prisma.outboxEvent.count({
          where: { dedupeKey: executionId },
        }),
      ).toBe(1);
      expect(
        await harness.prisma.organizationAuditEvent.count({
          where: { subjectId: executionId },
        }),
      ).toBe(1);
    });

    it('lets exactly one of a concurrent approve and reject through', async () => {
      const { executionId } = await propose();

      const [approve, reject] = await Promise.all([
        as(harness, owner).post(`${base()}/${executionId}/approve`),
        as(harness, orgAdmin).post(`${base()}/${executionId}/reject`),
      ]);

      expect([approve.status, reject.status].sort()).toEqual([201, 409]);

      const row = await execution(executionId);
      const winner = approve.status === 201 ? 'APPROVED' : 'REJECTED';
      expect(row.status).toBe(winner);
      expect(row.approval?.status).toBe(winner);
      expect(
        await harness.prisma.outboxEvent.count({
          where: { dedupeKey: executionId },
        }),
      ).toBe(winner === 'APPROVED' ? 1 : 0);
    });

    it('lists by decision state, newest first, with a cursor', async () => {
      const response = await as(harness, owner).get(
        `${base()}?status=PENDING&limit=1`,
      );

      expect(response.status).toBe(200);
      const page = (
        response.body as {
          data: {
            items: { approval: { status: string } }[];
            nextCursor: string | null;
          };
        }
      ).data;
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.approval.status).toBe('PENDING');
      expect(page.nextCursor).toEqual(expect.any(String));

      const next = await as(harness, owner).get(
        `${base()}?status=PENDING&limit=1&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
      );
      expect(next.status).toBe(200);
    });
  });

  describe('the effect', () => {
    const approved = async () => {
      const proposed = await propose();
      await as(harness, owner)
        .post(`${base()}/${proposed.executionId}/approve`)
        .expect(201);
      return proposed;
    };

    it('does not execute before approval, and never after rejection', async () => {
      delivery.reset();
      const pending = await propose();
      await handler.handle(job(pending.executionId, organizationId));
      expect(delivery.calls).toEqual([]);
      expect((await execution(pending.executionId)).status).toBe(
        'AWAITING_APPROVAL',
      );

      await as(harness, owner)
        .post(`${base()}/${pending.executionId}/reject`)
        .expect(201);
      await handler.handle(job(pending.executionId, organizationId));
      expect(delivery.calls).toEqual([]);
      expect((await execution(pending.executionId)).status).toBe('REJECTED');
    });

    it('sends once with a key derived from the execution, and records the provider id', async () => {
      delivery.reset();
      const { executionId } = await approved();

      await handler.handle(job(executionId, organizationId));

      expect(delivery.calls).toHaveLength(1);
      expect(delivery.calls[0]).toMatchObject({
        to: recipient.email,
        subject: 'Handoff ready',
        text: 'Please review the draft.',
        idempotencyKey: `notification.send@1:${executionId}`,
      });

      const row = await execution(executionId);
      const key = idempotencyKeyFor({
        id: executionId,
        toolId: 'notification.send',
        toolVersion: 1,
      });
      expect(row).toMatchObject({
        status: 'SUCCEEDED',
        effectAttemptCount: 1,
        providerMessageId: providerIdFor(key),
      });
      expect(row.effectFirstAttemptedAt).not.toBeNull();
      expect(row.effectPayloadDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(row.completedAt).not.toBeNull();
      expect(JSON.stringify(row)).not.toContain(key);
      expect(JSON.stringify(row)).not.toContain(recipient.email);

      const view = await as(harness, owner).get(`${base()}/${executionId}`);
      expect(view.status).toBe(200);
      expect(JSON.stringify(view.body)).not.toContain(key);
      expect(JSON.stringify(view.body)).not.toContain('effectPayloadDigest');
      expect(JSON.stringify(view.body)).not.toContain(providerIdFor(key));
    });

    it('settles an approved effect exactly once, and only in its own organization', async () => {
      delivery.reset();
      const { executionId } = await approved();
      await handler.handle(job(executionId, organizationId));
      const settled = await execution(executionId);
      expect(settled.status).toBe('SUCCEEDED');

      await expect(
        executions.settleEffect(executionId, organizationId, {
          status: 'FAILED',
          failureCode: 'provider_rejected',
        }),
      ).resolves.toBe(false);
      await expect(
        executions.settleEffect(executionId, organizationId, {
          status: 'OUTCOME_UNKNOWN',
        }),
      ).resolves.toBe(false);

      const after = await execution(executionId);
      expect(after.status).toBe('SUCCEEDED');
      expect(after.providerMessageId).toBe(settled.providerMessageId);
      expect(after.failureCode).toBeNull();
      expect(after.completedAt).toEqual(settled.completedAt);

      const other = await approved();
      await expect(
        executions.settleEffect(other.executionId, otherOrganizationId, {
          status: 'OUTCOME_UNKNOWN',
        }),
      ).resolves.toBe(false);
      expect((await execution(other.executionId)).status).toBe('APPROVED');
    });

    it('does not resend past the provider idempotency window, against the real row', async () => {
      delivery.reset();
      const { executionId } = await approved();
      delivery.answer = () => Promise.resolve({ kind: 'unavailable' });
      await expect(
        handler.handle(job(executionId, organizationId, { attemptsMade: 0 })),
      ).rejects.toThrow();

      await harness.prisma.toolExecution.update({
        where: { id: executionId },
        data: {
          effectFirstAttemptedAt: new Date(
            Date.now() - EFFECT_RETRY_WINDOW_MS - 60 * 60 * 1_000,
          ),
        },
      });
      delivery.reset();
      await handler.handle(
        job(executionId, organizationId, { attemptsMade: 1 }),
      );

      expect(delivery.calls).toEqual([]);
      expect((await execution(executionId)).status).toBe('OUTCOME_UNKNOWN');
    });

    it('does not send again on a duplicate delivery', async () => {
      delivery.reset();
      const { executionId } = await approved();

      await handler.handle(job(executionId, organizationId));
      await handler.handle(job(executionId, organizationId));
      await handler.handle(
        job(executionId, organizationId, { attemptsMade: 1 }),
      );

      expect(delivery.calls).toHaveLength(1);
      expect((await execution(executionId)).effectAttemptCount).toBe(1);
    });

    it('lets concurrent deliveries produce one provider effect', async () => {
      delivery.reset();
      const { executionId } = await approved();
      delivery.answer = (message) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                kind: 'accepted',
                providerMessageId: providerIdFor(message.idempotencyKey),
              }),
            50,
          ),
        );

      const results = await Promise.allSettled([
        handler.handle(job(executionId, organizationId)),
        handler.handle(job(executionId, organizationId)),
      ]);

      const statuses = results.map((result) => result.status).sort();
      expect(statuses[0]).toBe('fulfilled');
      expect(delivery.calls).toHaveLength(1);
      expect((await execution(executionId)).status).toBe('SUCCEEDED');

      await handler.handle(
        job(executionId, organizationId, { attemptsMade: 1 }),
      );
      expect(delivery.calls).toHaveLength(1);
    });

    it('retries an ambiguous first attempt with the same key and the same payload', async () => {
      delivery.reset();
      const { executionId } = await approved();
      delivery.answer = () => Promise.resolve({ kind: 'unavailable' });

      await expect(
        handler.handle(job(executionId, organizationId, { attemptsMade: 0 })),
      ).rejects.toThrow('Side-effect delivery attempt failed');

      const afterFirst = await execution(executionId);
      expect(afterFirst.status).toBe('APPROVED');
      expect(afterFirst.effectAttemptCount).toBe(1);

      delivery.reset();
      await handler.handle(
        job(executionId, organizationId, { attemptsMade: 1 }),
      );

      expect(delivery.calls).toHaveLength(1);
      expect(delivery.calls[0]?.idempotencyKey).toBe(
        `notification.send@1:${executionId}`,
      );
      const afterSecond = await execution(executionId);
      expect(afterSecond.status).toBe('SUCCEEDED');
      expect(afterSecond.effectAttemptCount).toBe(2);
      expect(afterSecond.effectPayloadDigest).toBe(
        afterFirst.effectPayloadDigest,
      );
    });

    it('records OUTCOME_UNKNOWN, not FAILED, when the last attempt is ambiguous — and never sends after', async () => {
      delivery.reset();
      const { executionId } = await approved();
      delivery.answer = () => Promise.resolve({ kind: 'unavailable' });

      await handler.handle(
        job(executionId, organizationId, { attemptsMade: 2, attempts: 3 }),
      );

      const row = await execution(executionId);
      expect(row.status).toBe('OUTCOME_UNKNOWN');
      expect(row.failureCode).toBeNull();
      expect(row.providerMessageId).toBeNull();

      delivery.reset();
      await handler.handle(job(executionId, organizationId));
      expect(delivery.calls).toEqual([]);
    });

    it('records a deterministic provider refusal as FAILED with the closed code only', async () => {
      delivery.reset();
      const { executionId } = await approved();
      delivery.answer = () => Promise.resolve({ kind: 'rejected' });

      await handler.handle(job(executionId, organizationId));

      const row = await execution(executionId);
      expect(row).toMatchObject({
        status: 'FAILED',
        failureCode: 'provider_rejected',
      });
    });

    it('does not perform the effect when the deployment cannot deliver idempotently', async () => {
      delivery.reset();
      const { executionId } = await approved();
      const unsupported = new SideEffectExecutionHandler(
        new DeliverApprovedToolEffectUseCase(
          executions,
          new ToolAuthorizationService(
            harness.prisma,
            new ToolRegistry(APPLICATION_TOOL_DEFINITIONS),
            new AgentDefinitionRegistry(DEFINITIONS),
            [
              {
                ref: KNOWLEDGE_REF,
                execute: () => Promise.resolve({ passages: [] }),
              },
              new NotificationSendTool(harness.prisma, {
                idempotent: false,
                sender: 'Acme <no-reply@example.test>',
                deliver: () => {
                  delivery.calls.push({} as NotificationMessage);
                  return Promise.resolve({ kind: 'rejected' as const });
                },
              }),
            ],
          ),
        ),
        silentLogger as never,
      );

      await unsupported.handle(job(executionId, organizationId));

      expect(delivery.calls).toEqual([]);
      expect(await execution(executionId)).toMatchObject({
        status: 'FAILED',
        failureCode: 'delivery_unsupported',
        effectAttemptCount: 0,
      });
    });
  });

  describe('revalidation immediately before the effect', () => {
    const approved = async (
      input: { recipientMemberId?: string } = {},
      org = organizationId,
      pinnedVersionId = versionId,
    ) => {
      const proposed = await propose(input, org, pinnedVersionId);
      await harness.prisma.$transaction([
        harness.prisma.toolExecutionApproval.update({
          where: { toolExecutionId: proposed.executionId },
          data: {
            status: 'APPROVED',
            decidedAt: new Date(),
            decidedByUserId: owner.id,
          },
        }),
        harness.prisma.toolExecution.update({
          where: { id: proposed.executionId },
          data: { status: 'APPROVED' },
        }),
      ]);
      return proposed;
    };

    it('does not send to a member removed after approval', async () => {
      delivery.reset();
      const leaver = await createUser(harness);
      await addMember(leaver, 'member');
      const leaverMemberId = await memberIdOf(leaver.id);
      const { executionId } = await approved({
        recipientMemberId: leaverMemberId,
      });

      await harness.prisma.member.delete({ where: { id: leaverMemberId } });
      await handler.handle(job(executionId, organizationId));

      expect(delivery.calls).toEqual([]);
      expect(await execution(executionId)).toMatchObject({
        status: 'FAILED',
        failureCode: 'precondition_recipient',
        effectAttemptCount: 0,
      });
    });

    it('records OUTCOME_UNKNOWN for a recipient removed after an ambiguous attempt', async () => {
      delivery.reset();
      const leaver = await createUser(harness);
      await addMember(leaver, 'member');
      const leaverMemberId = await memberIdOf(leaver.id);
      const { executionId } = await approved({
        recipientMemberId: leaverMemberId,
      });
      delivery.answer = () => Promise.resolve({ kind: 'unavailable' });
      await expect(
        handler.handle(job(executionId, organizationId, { attemptsMade: 0 })),
      ).rejects.toThrow();

      await harness.prisma.member.delete({ where: { id: leaverMemberId } });
      delivery.reset();
      await handler.handle(
        job(executionId, organizationId, { attemptsMade: 1 }),
      );

      expect(delivery.calls).toEqual([]);
      const row = await execution(executionId);
      expect(row.status).toBe('OUTCOME_UNKNOWN');
      expect(row.failureCode).toBeNull();
    });

    it('does not send to a member who moved to another organization', async () => {
      delivery.reset();
      const mover = await createUser(harness);
      await addMember(mover, 'member');
      const moverMemberId = await memberIdOf(mover.id);
      const { executionId } = await approved({
        recipientMemberId: moverMemberId,
      });

      await harness.prisma.member.update({
        where: { id: moverMemberId },
        data: { organizationId: otherOrganizationId },
      });
      await handler.handle(job(executionId, organizationId));

      expect(delivery.calls).toEqual([]);
      expect((await execution(executionId)).failureCode).toBe(
        'precondition_recipient',
      );
    });

    it('does not send to a deactivated account', async () => {
      delivery.reset();
      const gone = await createUser(harness);
      await addMember(gone, 'member');
      const { executionId } = await approved({
        recipientMemberId: await memberIdOf(gone.id),
      });

      await harness.prisma.user.update({
        where: { id: gone.id },
        data: { deletedAt: new Date() },
      });
      await handler.handle(job(executionId, organizationId));

      expect(delivery.calls).toEqual([]);
      expect((await execution(executionId)).failureCode).toBe(
        'precondition_recipient',
      );
    });

    it('does not send for an organization archived after approval', async () => {
      delivery.reset();
      const archived = await createOrganization(owner, 'approvals-archived');
      const archivedOwnerMemberId = await memberIdOf(owner.id, archived);
      const installations = new OrganizationAgentInstallationService(
        harness.prisma,
        new AgentDefinitionRegistry(DEFINITIONS),
      );
      const installed = await installations.create(
        archived,
        {
          agentId: AGENT_ID,
          definitionVersion: 1,
          enabled: true,
          toolGrants: [REF] as never,
        },
        owner.id,
      );
      const { executionId } = await approved(
        { recipientMemberId: archivedOwnerMemberId },
        archived,
        installed.activeVersionId,
      );

      await harness.prisma.organization.update({
        where: { id: archived },
        data: { archivedAt: new Date(), archivedByUserId: owner.id },
      });
      await handler.handle(job(executionId, archived));

      expect(delivery.calls).toEqual([]);
      expect((await execution(executionId)).failureCode).toBe(
        'precondition_organization',
      );
    });

    it('does not send when the pinned version no longer grants the tool', async () => {
      delivery.reset();
      const { executionId } = await approved();

      await harness.prisma.organizationAgentVersion.update({
        where: { id: versionId },
        data: { toolGrants: [] },
      });
      try {
        await handler.handle(job(executionId, organizationId));
      } finally {
        await harness.prisma.organizationAgentVersion.update({
          where: { id: versionId },
          data: { toolGrants: [REF] },
        });
      }

      expect(delivery.calls).toEqual([]);
      expect((await execution(executionId)).failureCode).toBe(
        'precondition_authority',
      );
    });

    it('does not send when the definition no longer permits the tool', async () => {
      delivery.reset();
      const { executionId } = await approved();
      const narrowed = new SideEffectExecutionHandler(
        new DeliverApprovedToolEffectUseCase(
          executions,
          new ToolAuthorizationService(
            harness.prisma,
            new ToolRegistry(APPLICATION_TOOL_DEFINITIONS),
            new AgentDefinitionRegistry([approvalAgent([KNOWLEDGE_REF])]),
            [
              {
                ref: KNOWLEDGE_REF,
                execute: () => Promise.resolve({ passages: [] }),
              },
              tool,
            ],
          ),
        ),
        silentLogger as never,
      );

      await narrowed.handle(job(executionId, organizationId));

      expect(delivery.calls).toEqual([]);
      expect((await execution(executionId)).failureCode).toBe(
        'precondition_authority',
      );
    });

    it('does not send a payload that differs from the one approved', async () => {
      delivery.reset();
      const { executionId } = await approved();

      await harness.prisma.toolExecution.update({
        where: { id: executionId },
        data: {
          input: {
            recipientMemberId,
            subject: 'Handoff ready',
            body: 'Wire the money to account 12345.',
          },
        },
      });
      await handler.handle(job(executionId, organizationId));

      expect(delivery.calls).toEqual([]);
      expect((await execution(executionId)).failureCode).toBe(
        'precondition_approval',
      );
    });

    it('does not resend when the effective payload changed after an ambiguous attempt', async () => {
      delivery.reset();
      const changer = await createUser(harness);
      await addMember(changer, 'member');
      const { executionId } = await approved({
        recipientMemberId: await memberIdOf(changer.id),
      });
      delivery.answer = () => Promise.resolve({ kind: 'unavailable' });
      await expect(
        handler.handle(job(executionId, organizationId, { attemptsMade: 0 })),
      ).rejects.toThrow();

      await harness.prisma.user.update({
        where: { id: changer.id },
        data: { email: `changed-${changer.email}` },
      });
      delivery.reset();
      await handler.handle(
        job(executionId, organizationId, { attemptsMade: 1 }),
      );

      expect(delivery.calls).toEqual([]);
      expect((await execution(executionId)).status).toBe('OUTCOME_UNKNOWN');
    });
  });

  describe('tenancy at the database', () => {
    it('refuses an approval that names another organization', async () => {
      const { executionId } = await propose();
      await harness.prisma.toolExecutionApproval.delete({
        where: { toolExecutionId: executionId },
      });

      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();

      try {
        await expect(
          client.query(
            `INSERT INTO "tool_execution_approval"
               ("id","organizationId","toolExecutionId","status","inputDigest",
                "requestedAt","createdAt","updatedAt")
             VALUES ($1,$2,$3,'PENDING','x',NOW(),NOW(),NOW())`,
            [`cross-tenant-${Date.now()}`, otherOrganizationId, executionId],
          ),
        ).rejects.toMatchObject({
          code: '23503',
          constraint:
            'tool_execution_approval_toolExecutionId_organizationId_fkey',
        });

        await expect(
          client.query(
            `INSERT INTO "tool_execution_approval"
               ("id","organizationId","toolExecutionId","status","inputDigest",
                "requestedAt","createdAt","updatedAt")
             VALUES ($1,$2,$3,'PENDING','x',NOW(),NOW(),NOW())`,
            [`control-${Date.now()}`, organizationId, executionId],
          ),
        ).resolves.toBeDefined();
      } finally {
        await client.end();
      }
    });

    it('accepts a tool_execution row written by the preceding image', async () => {
      const run = await acceptedRun();
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();

      try {
        const id = `previous-image-${Date.now()}`;
        await client.query(
          `INSERT INTO "tool_execution"
             ("id","organizationId","agentRunId","agentRunAttempt",
              "toolId","toolVersion","status","input","startedAt",
              "createdAt","updatedAt")
           VALUES ($1,$2,$3,1,'knowledge.search',1,'STARTED','{}',NOW(),NOW(),NOW())`,
          [id, organizationId, run.id],
        );

        const row = await harness.prisma.toolExecution.findUniqueOrThrow({
          where: { id },
        });
        expect(row).toMatchObject({
          effectAttemptCount: 0,
          effectFirstAttemptedAt: null,
          effectPayloadDigest: null,
          providerMessageId: null,
        });
      } finally {
        await client.end();
      }
    });

    it('allows exactly one approval per execution', async () => {
      const { executionId } = await propose();

      await expect(
        harness.prisma.toolExecutionApproval.create({
          data: {
            organizationId,
            toolExecutionId: executionId,
            status: 'PENDING',
            inputDigest: 'x',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('regression', () => {
    it('keeps knowledge.search read-only and inline', async () => {
      const run = await acceptedRun();
      const [exposed] = gateway.authorize({
        definition: DEFINITIONS[0],
        organizationId,
        agentRunId: run.id,
        agentRunAttempt: 1,
        grants: [KNOWLEDGE_REF],
      });

      await expect(exposed.execute({ query: 'tone' })).resolves.toEqual({
        passages: [],
      });

      const rows = await harness.prisma.toolExecution.findMany({
        where: { agentRunId: run.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        toolId: 'knowledge.search',
        status: 'SUCCEEDED',
      });
      expect(
        await harness.prisma.toolExecutionApproval.count({
          where: { toolExecutionId: rows[0]?.id },
        }),
      ).toBe(0);
    });
  });
});
