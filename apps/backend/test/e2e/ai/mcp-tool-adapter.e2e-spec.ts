import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { Job } from 'bullmq';
import { z } from 'zod';

import { AgentDefinitionRegistry } from '../../../src/ai/agents/agent-definition.registry';
import type { AgentDefinition } from '../../../src/ai/agents/agent.types';
import { MCP_SESSION_TTL_MS } from '../../../src/ai/agents/agent.types';
import { MCP_SESSION_TOOL_CALL_BUDGET } from '../../../src/features/agent-management/mcp/mcp-session.types';
import { OrganizationAgentInstallationService } from '../../../src/features/agent-management/organization-agent-installation.service';
import { APPLICATION_TOOL_DEFINITIONS } from '../../../src/features/agent-management/tools/definitions';
import { NotificationSendTool } from '../../../src/features/agent-management/tools/notification-send.tool';
import {
  idempotencyKeyFor,
  SideEffectExecutionHandler,
  type SideEffectExecutionJob,
} from '../../../src/workers/handlers/side-effect-execution.handler';
import { ToolExecutionService } from '../../../src/ai/tools/tool-execution.service';
import { ToolRegistry } from '../../../src/ai/tools/tool.registry';
import {
  FeatureFlagService,
  RuntimeSettingService,
} from '../../../src/features/control-plane';
import type {
  ExternalEffectOutcome,
  NotificationDelivery,
  NotificationMessage,
} from '../../../src/infrastructure/mail/notification-delivery.port';
import {
  EMBEDDING_DIMENSIONS,
  KnowledgeWriterService,
} from '../../../src/features/knowledge';
import { MODEL_IDS } from '../../../src/ai/models/model-catalog';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

const AGENT_ID = 'mcp-adapter-test-agent';
const KNOWLEDGE_REF = 'knowledge.search@1';
const NOTIFY_REF = 'notification.send@1';
const SPACE = 'brand.voice';
const MODEL = 'text-embedding-3-small';

const mcpAgent = (version: number): AgentDefinition => ({
  id: AGENT_ID,
  version,
  runtime: 'mastra',
  instructions: 'Answer from the organization’s material.',
  model: MODEL_IDS.openAiGpt4oMini,
  modelPolicy: {
    id: `${AGENT_ID}.model-policy.${version}`,
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  input: z.unknown(),
  output: z.unknown(),
  organizationConfiguration: {
    schema: z.object({}).strict(),
    defaultValue: {},
  },
  contextPolicy: { spaceSlugs: [SPACE], maxChunks: 4, maxCharacters: 2_000 },
  maxToolGrants: [KNOWLEDGE_REF, NOTIFY_REF] as never,
});

const DEFINITIONS = [mcpAgent(1)] as const;

const ENABLED_FLAGS = ['agents.enabled', 'mcp.enabled'] as const;

const axis = (index: number): number[] =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === index ? 1 : 0));

class RecordingDelivery implements NotificationDelivery {
  readonly idempotent = true;
  readonly sender = 'Acme <no-reply@example.test>';
  readonly calls: NotificationMessage[] = [];

  deliver(message: NotificationMessage): Promise<ExternalEffectOutcome> {
    this.calls.push(message);
    return Promise.resolve({
      kind: 'accepted',
      providerMessageId: `msg_${this.calls.length}`,
    });
  }
}

const silentLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const job = (toolExecutionId: string, organizationId: string) =>
  ({
    data: { toolExecutionId, organizationId },
    opts: { attempts: 3 },
    attemptsMade: 0,
    attemptsStarted: 1,
  }) as unknown as Job<SideEffectExecutionJob>;

describe('MCP as an adapter over the governed tool gateway', () => {
  let harness: Harness;
  let owner: TestUser;
  let otherAdmin: TestUser;
  let member: TestUser;
  let recipient: TestUser;
  let outsider: TestUser;
  let superAdmin: TestUser;
  let openers: TestUser[];
  let nextOpener = 0;
  let organizationId: string;
  let otherOrganizationId: string;
  let recipientMemberId: string;
  let installationId: string;
  let delivery: RecordingDelivery;

  const ownedOrganizationIds: string[] = [];

  const openRunIds: string[] = [];

  const base = (org = organizationId) =>
    `/organizations/${encodeURIComponent(org)}/mcp-sessions`;

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
    host = owner,
  ) => {
    const invite = await as(harness, host).post(
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

  const install = async (org: string, toolGrants: readonly string[]) => {
    const installed = await harness.app
      .get(OrganizationAgentInstallationService)
      .create(
        org,
        {
          agentId: AGENT_ID,
          definitionVersion: 1,
          enabled: true,
          configuration: {},
          toolGrants: toolGrants as never,
        },
        superAdmin.id,
      );

    return installed.id;
  };

  const regrant = async (toolGrants: readonly string[]) => {
    const { revision } =
      await harness.prisma.organizationAgentInstallation.findUniqueOrThrow({
        where: { id: installationId },
        select: { revision: true },
      });

    return harness.app.get(OrganizationAgentInstallationService).replace(
      organizationId,
      installationId,
      {
        definitionVersion: 1,
        enabled: true,
        configuration: {},
        expectedRevision: revision,
        toolGrants: toolGrants as never,
      },
      superAdmin.id,
    );
  };

  const seedKnowledge = async (org: string, content: string, at: number) => {
    const space = await harness.prisma.knowledgeSpace.create({
      data: { organizationId: org, slug: SPACE, name: SPACE },
      select: { id: true },
    });
    const document = await harness.prisma.knowledgeDocument.create({
      data: {
        organizationId: org,
        spaceId: space.id,
        title: content,
        checksum: `checksum-${at}`,
      },
      select: { id: true },
    });
    const chunk = await harness.prisma.knowledgeChunk.create({
      data: {
        organizationId: org,
        spaceId: space.id,
        documentId: document.id,
        ordinal: 0,
        content,
      },
      select: { id: true },
    });

    const written = await harness.app.get(KnowledgeWriterService).setEmbedding({
      chunkId: chunk.id,
      organizationId: org,
      embedding: axis(at),
      model: MODEL,
    });
    expect(written).toBe(true);
  };

  const opener = (): TestUser => {
    const user = openers[nextOpener % openers.length];
    nextOpener += 1;
    return user;
  };

  const openSession = async (org = organizationId) => {
    const user = opener();
    const { runId } = await open(user, org);
    return { user, runId };
  };

  const open = async (
    user: TestUser,
    org = organizationId,
    key = `mcp-${Math.random().toString(36).slice(2)}`,
  ) => {
    const response = await as(harness, user)
      .post(base(org))
      .set('idempotency-key', key)
      .send({ agentId: AGENT_ID });

    expect(response.status).toBe(201);

    const data = (response.body as { data: { runId: string } }).data;
    openRunIds.push(data.runId);

    return data;
  };

  const clientFor = async (
    user: TestUser,
    runId: string,
    org = organizationId,
    options: { origin?: string; headers?: Record<string, string> } = {},
  ) => {
    const path = `${base(org)}/${encodeURIComponent(runId)}/mcp`;
    const client = new Client(
      { name: 'e2e-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1${path}`),
      {
        fetch: async (_url, init) => {
          const method = (init?.method ?? 'GET').toUpperCase();

          let call =
            method === 'POST'
              ? as(harness, user).post(path)
              : method === 'DELETE'
                ? as(harness, user).del(path)
                : as(harness, user).get(path);

          new Headers(init?.headers).forEach((value, name) => {
            call = call.set(name, value);
          });

          if (options.origin) call = call.set('origin', options.origin);
          if (options.headers) {
            for (const [headerName, headerValue] of Object.entries(
              options.headers,
            )) {
              call = call.set(headerName, headerValue);
            }
          }

          const body =
            typeof init?.body === 'string'
              ? (JSON.parse(init.body) as object)
              : undefined;

          const response = body ? await call.send(body) : await call.send();

          return new Response(response.text ?? JSON.stringify(response.body), {
            status: response.status,
            headers: {
              'content-type': String(
                response.headers['content-type'] ?? 'application/json',
              ),
            },
          });
        },
      },
    );

    await client.connect(transport);

    return { client, close: () => client.close() };
  };

  beforeAll(async () => {
    delivery = new RecordingDelivery();

    harness = await createHarness({
      definitions: DEFINITIONS,
      embeddings: {
        model: MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        maxBatch: 8,
        embed: (texts) => Promise.resolve(texts.map(() => axis(1))),
      },
    });

    owner = await createUser(harness);
    otherAdmin = await createUser(harness);
    member = await createUser(harness);
    recipient = await createUser(harness);
    outsider = await createUser(harness);
    superAdmin = await createUser(harness, { role: 'super_admin' });

    organizationId = await createOrganization(owner, 'mcp-acme');
    otherOrganizationId = await createOrganization(outsider, 'mcp-other');

    await addMember(otherAdmin, 'admin', organizationId);
    await addMember(member, 'member', organizationId);
    await addMember(recipient, 'member', organizationId);

    recipientMemberId = (
      await harness.prisma.member.findFirstOrThrow({
        where: { userId: recipient.id, organizationId },
        select: { id: true },
      })
    ).id;

    openers = [];
    for (let i = 0; i < 8; i += 1) {
      const extra = await createUser(harness);
      await addMember(extra, 'admin', organizationId);
      openers.push(extra);
    }

    for (const key of ENABLED_FLAGS) {
      for (const target of [organizationId, otherOrganizationId]) {
        await harness.app.get(FeatureFlagService).setOrganizationOverride({
          key,
          organizationId: target,
          enabled: true,
          actorUserId: superAdmin.id,
        });
      }
    }

    installationId = await install(organizationId, [KNOWLEDGE_REF, NOTIFY_REF]);
    await install(otherOrganizationId, [KNOWLEDGE_REF]);

    await seedKnowledge(organizationId, 'Our brand voice is plain.', 1);
    await seedKnowledge(otherOrganizationId, 'A different tenant’s secret.', 1);
  }, 30_000);

  afterEach(async () => {
    if (openRunIds.length === 0) return;

    await harness.prisma.agentRun.updateMany({
      where: { id: { in: openRunIds }, status: 'RUNNING' },
      data: {
        status: 'SUCCEEDED',
        completedAt: new Date(),
        output: { closedBy: 'client' },
      },
    });

    openRunIds.length = 0;
  });

  afterAll(async () => {
    try {
      await harness.prisma.toolExecutionApproval.deleteMany({
        where: { organizationId: { in: ownedOrganizationIds } },
      });
      await harness.prisma.toolExecution.deleteMany({
        where: { organizationId: { in: ownedOrganizationIds } },
      });
      await harness.prisma.agentRun.deleteMany({
        where: { organizationId: { in: ownedOrganizationIds } },
      });
    } finally {
      await harness.close();
    }
  });

  describe('opening a session', () => {
    it('accepts a session as a running agent run driven by no worker', async () => {
      const session = await open(owner);

      const run = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: session.runId },
        select: {
          runtime: true,
          status: true,
          startedAt: true,
          attemptCount: true,
          organizationId: true,
          createdByUserId: true,
          organizationAgentVersionId: true,
          agentVersion: true,
        },
      });

      expect(run).toMatchObject({
        runtime: 'mcp',
        status: 'RUNNING',
        attemptCount: 1,
        organizationId,
        createdByUserId: owner.id,
        agentVersion: 1,
      });
      expect(run.startedAt).not.toBeNull();
      expect(run.organizationAgentVersionId).not.toBeNull();
    });

    it('publishes no queue intent for a session', async () => {
      const { runId } = await openSession();

      const events = await harness.prisma.outboxEvent.findMany({
        where: { dedupeKey: runId },
        select: { id: true },
      });

      expect(events).toEqual([]);
    });

    it('returns an absolute expiry a client can plan against', async () => {
      const before = Date.now();
      const response = await as(harness, opener())
        .post(base())
        .set('idempotency-key', `mcp-expiry-${Date.now()}`)
        .send({ agentId: AGENT_ID });

      expect(response.status).toBe(201);

      const { expiresAt } = (response.body as { data: { expiresAt: string } })
        .data;

      const expiry = Date.parse(expiresAt);
      expect(expiry).toBeGreaterThanOrEqual(
        before + MCP_SESSION_TTL_MS - 5_000,
      );
      expect(expiry).toBeLessThanOrEqual(
        Date.now() + MCP_SESSION_TTL_MS + 5_000,
      );
    });

    it('answers a repeated idempotency key with the same session', async () => {
      const key = `mcp-repeat-${Date.now()}`;
      const user = opener();

      const first = await open(user, organizationId, key);
      const second = await open(user, organizationId, key);

      expect(second.runId).toBe(first.runId);
    });

    it('refuses a member without the permission', async () => {
      const response = await as(harness, member)
        .post(base())
        .set('idempotency-key', `mcp-member-${Date.now()}`)
        .send({ agentId: AGENT_ID });

      expect(response.status).toBe(403);
    });

    it('refuses a caller from outside the organization', async () => {
      const response = await as(harness, outsider)
        .post(base())
        .set('idempotency-key', `mcp-outsider-${Date.now()}`)
        .send({ agentId: AGENT_ID });

      expect([403, 404]).toContain(response.status);
    });

    it('requires an idempotency key', async () => {
      const response = await as(harness, opener())
        .post(base())
        .send({ agentId: AGENT_ID });

      expect(response.status).toBe(400);
      expect(errorBody(response).error?.details).toMatchObject({
        kind: 'validation',
        messages: ['idempotency_key_required'],
      });
    });

    it('refuses an agent the organization has not installed', async () => {
      const response = await as(harness, opener())
        .post(base())
        .set('idempotency-key', `mcp-missing-${Date.now()}`)
        .send({ agentId: 'not-installed-agent' });

      expect(response.status).toBe(404);
    });
  });

  describe('the authorized tool set', () => {
    it('offers exactly the tools the pinned version granted', async () => {
      const { user, runId } = await openSession();
      const { client, close } = await clientFor(user, runId);

      const listed = await client.listTools();

      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        'knowledge_search_v1',
        'notification_send_v1',
      ]);

      await close();
    });

    it('omits a tool the organization did not grant', async () => {
      const session = await open(outsider, otherOrganizationId);
      const { client, close } = await clientFor(
        outsider,
        session.runId,
        otherOrganizationId,
      );

      const listed = await client.listTools();

      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'knowledge_search_v1',
      ]);

      await close();
    });

    it('fails closed when an ungranted tool is named directly', async () => {
      const session = await open(outsider, otherOrganizationId);
      const { client, close } = await clientFor(
        outsider,
        session.runId,
        otherOrganizationId,
      );

      await expect(
        client.callTool({
          name: 'notification_send_v1',
          arguments: {
            recipientMemberId: 'anything',
            subject: 'x',
            body: 'y',
          },
        }),
      ).rejects.toMatchObject({ code: -32602 });

      await close();
    });

    it('is unaffected by a grant change made after acceptance', async () => {
      const { user, runId } = await openSession();

      await regrant([KNOWLEDGE_REF]);

      try {
        const { client, close } = await clientFor(user, runId);

        expect(
          (await client.listTools()).tools.map((t) => t.name).sort(),
        ).toEqual(['knowledge_search_v1', 'notification_send_v1']);

        await close();

        const narrowed = await openSession();
        const after = await clientFor(narrowed.user, narrowed.runId);

        expect(
          (await after.client.listTools()).tools.map((t) => t.name),
        ).toEqual(['knowledge_search_v1']);

        await after.close();
      } finally {
        await regrant([KNOWLEDGE_REF, NOTIFY_REF]);
      }
    });
  });

  describe('a read-only tool through MCP', () => {
    it('returns this organization’s material and records the execution', async () => {
      const { user, runId } = await openSession();
      const { client, close } = await clientFor(user, runId);

      const result = await client.callTool({
        name: 'knowledge_search_v1',
        arguments: { query: 'brand voice' },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        passages: [{ space: SPACE, content: 'Our brand voice is plain.' }],
      });

      const executions = await harness.prisma.toolExecution.findMany({
        where: { agentRunId: runId },
        select: {
          status: true,
          toolId: true,
          toolVersion: true,
          organizationId: true,
          agentRunAttempt: true,
        },
      });

      expect(executions).toEqual([
        {
          status: 'SUCCEEDED',
          toolId: 'knowledge.search',
          toolVersion: 1,
          organizationId,
          agentRunAttempt: 1,
        },
      ]);

      await close();
    });

    it('cannot read another organization’s material', async () => {
      const session = await open(outsider, otherOrganizationId);
      const { client, close } = await clientFor(
        outsider,
        session.runId,
        otherOrganizationId,
      );

      const result = await client.callTool({
        name: 'knowledge_search_v1',
        arguments: { query: 'brand voice' },
      });

      const rendered = JSON.stringify(result.structuredContent);
      expect(rendered).not.toContain('Our brand voice is plain.');
      expect(rendered).toContain('A different tenant');

      await close();
    });

    it('refuses an attempt to widen scope through tool arguments', async () => {
      const { user, runId } = await openSession();
      const { client, close } = await clientFor(user, runId);

      const result = await client.callTool({
        name: 'knowledge_search_v1',
        arguments: {
          query: 'brand voice',
          organizationId: otherOrganizationId,
          spaceSlugs: ['brand', 'secret'],
        },
      });

      expect(result.isError).toBe(true);

      await close();
    });
  });

  describe('a side-effecting tool through MCP', () => {
    it('can only propose, and reaches no provider', async () => {
      const { user, runId } = await openSession();
      const { client, close } = await clientFor(user, runId);

      const result = await client.callTool({
        name: 'notification_send_v1',
        arguments: {
          recipientMemberId,
          subject: 'Handoff ready',
          body: 'Please review the draft.',
        },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        status: 'awaiting_approval',
      });

      const execution = await harness.prisma.toolExecution.findFirstOrThrow({
        where: { agentRunId: runId, toolId: 'notification.send' },
        select: {
          id: true,
          status: true,
          approval: { select: { status: true } },
        },
      });

      expect(execution.status).toBe('AWAITING_APPROVAL');
      expect(execution.approval?.status).toBe('PENDING');

      expect(delivery.calls).toEqual([]);

      await close();
    });

    it('never sends when a human rejects the proposal', async () => {
      const { user, runId } = await openSession();
      const { client, close } = await clientFor(user, runId);

      await client.callTool({
        name: 'notification_send_v1',
        arguments: {
          recipientMemberId,
          subject: 'Rejected handoff',
          body: 'This must not be sent.',
        },
      });
      await close();

      const execution = await harness.prisma.toolExecution.findFirstOrThrow({
        where: { agentRunId: runId, toolId: 'notification.send' },
        select: { id: true },
      });

      const rejected = await as(harness, owner)
        .post(
          `/organizations/${organizationId}/agent-action-approvals/${execution.id}/reject`,
        )
        .send({ note: 'Not now.' });

      expect(rejected.status).toBe(201);

      const after = await harness.prisma.toolExecution.findUniqueOrThrow({
        where: { id: execution.id },
        select: { status: true },
      });

      expect(after.status).toBe('REJECTED');
      expect(delivery.calls).toEqual([]);
    });

    it('is delivered by the same worker path, under the same idempotency key', async () => {
      const { user, runId } = await openSession();
      const { client, close } = await clientFor(user, runId);

      await client.callTool({
        name: 'notification_send_v1',
        arguments: {
          recipientMemberId,
          subject: 'Approved handoff',
          body: 'Please review the draft.',
        },
      });
      await close();

      const execution = await harness.prisma.toolExecution.findFirstOrThrow({
        where: { agentRunId: runId, toolId: 'notification.send' },
        select: { id: true, toolId: true, toolVersion: true },
      });

      const approved = await as(harness, owner)
        .post(
          `/organizations/${organizationId}/agent-action-approvals/${execution.id}/approve`,
        )
        .send({ note: 'Go ahead.' });

      expect(approved.status).toBe(201);

      expect(delivery.calls).toEqual([]);

      const handler = new SideEffectExecutionHandler(
        harness.prisma,
        harness.app.get(ToolExecutionService),
        new ToolRegistry(APPLICATION_TOOL_DEFINITIONS),
        harness.app.get(AgentDefinitionRegistry),
        [new NotificationSendTool(harness.prisma, delivery)],
        silentLogger as never,
      );

      await handler.handle(job(execution.id, organizationId));

      expect(delivery.calls).toHaveLength(1);
      expect(delivery.calls[0]?.idempotencyKey).toBe(
        idempotencyKeyFor(execution),
      );

      const settled = await harness.prisma.toolExecution.findUniqueOrThrow({
        where: { id: execution.id },
        select: { status: true, providerMessageId: true },
      });

      expect(settled.status).toBe('SUCCEEDED');
      expect(settled.providerMessageId).not.toBeNull();

      await handler.handle(job(execution.id, organizationId));
      expect(delivery.calls).toHaveLength(1);
    });
  });

  describe('who may drive a session', () => {
    it('refuses another admin of the same organization', async () => {
      const session = await open(owner);

      const response = await as(harness, otherAdmin)
        .post(`${base()}/${session.runId}/mcp`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(response.status).toBe(404);
    });

    it('does not find a session through another organization’s path', async () => {
      const session = await open(owner);

      const response = await as(harness, outsider)
        .post(`${base(otherOrganizationId)}/${session.runId}/mcp`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(response.status).toBe(404);
    });

    it('refuses a session id that does not exist', async () => {
      const response = await as(harness, owner)
        .post(`${base()}/00000000-0000-4000-8000-000000000000/mcp`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(response.status).toBe(404);
    });

    it('refuses a run that is not an MCP session', async () => {
      const workerRun = await harness.prisma.agentRun.create({
        data: {
          agentId: AGENT_ID,
          agentVersion: 1,
          runtime: 'mastra',
          status: 'RUNNING',
          organizationId,
          createdByUserId: owner.id,
          input: {},
          attemptCount: 1,
          idempotencyKey: `worker-${Date.now()}`,
        },
        select: { id: true },
      });

      const response = await as(harness, owner)
        .post(`${base()}/${workerRun.id}/mcp`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(response.status).toBe(404);
    });
  });

  describe('session lifetime', () => {
    it('closes on request and then refuses every exchange', async () => {
      const { user, runId } = await openSession();

      const closed = await as(harness, user).del(`${base()}/${runId}`);

      expect(closed.status).toBe(200);
      expect((closed.body as { data: unknown }).data).toMatchObject({
        closedBy: 'client',
      });

      const run = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, output: true, completedAt: true },
      });

      expect(run.status).toBe('SUCCEEDED');
      expect(run.output).toEqual({ closedBy: 'client' });
      expect(run.completedAt).not.toBeNull();

      const after = await as(harness, user)
        .post(`${base()}/${runId}/mcp`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(after.status).toBe(409);
      expect(errorBody(after).error?.details).toMatchObject({
        reason: 'session_closed',
      });
    });

    it('answers a second close without contradicting the first', async () => {
      const { user, runId } = await openSession();

      await as(harness, user).del(`${base()}/${runId}`).expect(200);
      const again = await as(harness, user).del(`${base()}/${runId}`);

      expect(again.status).toBe(200);
      expect((again.body as { data: unknown }).data).toMatchObject({
        closedBy: 'already_closed',
      });
    });

    it('allows another admin of the same organization to close the session', async () => {
      const session = await open(owner);

      const closed = await as(harness, otherAdmin).del(
        `${base()}/${session.runId}`,
      );

      expect(closed.status).toBe(200);
      expect((closed.body as { data: unknown }).data).toMatchObject({
        closedBy: 'client',
      });
    });

    it('refuses an ordinary member without mcpSession:create permission to close the session', async () => {
      const session = await open(owner);

      const response = await as(harness, member).del(
        `${base()}/${session.runId}`,
      );

      expect(response.status).toBe(403);
    });

    it('refuses to close a session belonging to another organization', async () => {
      const session = await open(owner);

      const response = await as(harness, outsider).del(
        `${base(otherOrganizationId)}/${session.runId}`,
      );

      expect(response.status).toBe(404);
    });

    it('closes an expired session and refuses the exchange', async () => {
      const { user, runId } = await openSession();

      await harness.prisma.agentRun.update({
        where: { id: runId },
        data: { createdAt: new Date(Date.now() - MCP_SESSION_TTL_MS - 1_000) },
      });

      const response = await as(harness, user)
        .post(`${base()}/${runId}/mcp`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(response.status).toBe(409);
      expect(errorBody(response).error?.details).toMatchObject({
        reason: 'session_expired',
      });

      const run = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, output: true },
      });

      expect(run.status).toBe('SUCCEEDED');
      expect(run.output).toEqual({ closedBy: 'expiry' });
    });
  });

  describe('the cost of a session', () => {
    it('refuses a tool call once the session has spent its budget', async () => {
      const { user, runId } = await openSession();

      await harness.prisma.toolExecution.createMany({
        data: Array.from({ length: MCP_SESSION_TOOL_CALL_BUDGET }, () => ({
          organizationId,
          agentRunId: runId,
          agentRunAttempt: 1,
          toolId: 'knowledge.search',
          toolVersion: 1,
          status: 'SUCCEEDED' as const,
          input: { query: 'earlier call' },
        })),
      });

      const { client, close } = await clientFor(user, runId);

      const result = await client.callTool({
        name: 'knowledge_search_v1',
        arguments: { query: 'one too many' },
      });

      expect(result.isError).toBe(true);

      const count = await harness.prisma.toolExecution.count({
        where: { agentRunId: runId },
      });
      expect(count).toBe(MCP_SESSION_TOOL_CALL_BUDGET);

      await close();
    });

    it('counts against the organization’s in-flight ceiling', async () => {
      const settings = harness.app.get(RuntimeSettingService);

      const inFlight = await harness.prisma.agentRun.count({
        where: { organizationId, status: { in: ['QUEUED', 'RUNNING'] } },
      });

      await settings.set({
        key: 'agents.max_concurrent_runs_per_organization',
        value: inFlight + 1,
        actorUserId: superAdmin.id,
      });

      try {
        await openSession();

        const refused = await as(harness, opener())
          .post(base())
          .set('idempotency-key', `mcp-ceiling-${Date.now()}`)
          .send({ agentId: AGENT_ID });

        expect(refused.status).toBe(429);
        expect(errorBody(refused).errorCode).toBe('TOO_MANY_REQUESTS');
      } finally {
        await settings.set({
          key: 'agents.max_concurrent_runs_per_organization',
          value: 10,
          actorUserId: superAdmin.id,
        });
      }
    });
  });

  describe('transport and operator boundaries', () => {
    it('allows a request carrying an exact trusted origin', async () => {
      const { user, runId } = await openSession();
      const { client, close } = await clientFor(user, runId, organizationId, {
        origin: 'http://localhost:3000',
      });

      await expect(client.listTools()).resolves.toBeDefined();

      await close();
    });

    it('refuses same hostname with wrong scheme', async () => {
      const { user, runId } = await openSession();

      const response = await as(harness, user)
        .post(`${base()}/${runId}/mcp`)
        .set('origin', 'https://localhost:3000')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(response.status).toBe(403);
      expect(errorBody(response).error?.details).toMatchObject({
        reason: 'origin_not_allowed',
      });
    });

    it('refuses same hostname with wrong port', async () => {
      const { user, runId } = await openSession();

      const response = await as(harness, user)
        .post(`${base()}/${runId}/mcp`)
        .set('origin', 'http://localhost:3999')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(response.status).toBe(403);
      expect(errorBody(response).error?.details).toMatchObject({
        reason: 'origin_not_allowed',
      });
    });

    it('refuses a request carrying an untrusted foreign origin', async () => {
      const { user, runId } = await openSession();

      const response = await as(harness, user)
        .post(`${base()}/${runId}/mcp`)
        .set('origin', 'https://attacker.example')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(response.status).toBe(403);
      expect(errorBody(response).error?.details).toMatchObject({
        reason: 'origin_not_allowed',
      });
    });

    it('allows a request with no origin at all', async () => {
      const { user, runId } = await openSession();
      const { client, close } = await clientFor(user, runId);

      await expect(client.listTools()).resolves.toBeDefined();

      await close();
    });

    it('refuses every exchange once an operator disables the feature', async () => {
      const { user, runId } = await openSession();
      const flags = harness.app.get(FeatureFlagService);

      await flags.setOrganizationOverride({
        key: 'mcp.enabled',
        organizationId,
        enabled: false,
        actorUserId: superAdmin.id,
      });

      try {
        const response = await as(harness, user)
          .post(`${base()}/${runId}/mcp`)
          .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

        expect(response.status).toBe(403);
      } finally {
        await flags.setOrganizationOverride({
          key: 'mcp.enabled',
          organizationId,
          enabled: true,
          actorUserId: superAdmin.id,
        });
      }
    });

    it('serves an exchange without forwarding the session cookie', async () => {
      const { user, runId } = await openSession();
      const { client, close } = await clientFor(user, runId);

      const listed = await client.listTools();

      expect(listed.tools.length).toBeGreaterThan(0);

      await close();
    });
  });

  describe('protocol transport constraints and edge cases', () => {
    it('returns 405 Method Not Allowed for GET on the MCP endpoint', async () => {
      const session = await open(owner);

      const response = await as(harness, owner).get(
        `${base()}/${session.runId}/mcp`,
      );

      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('POST');
      expect(response.body).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32_000,
          message: 'Method Not Allowed',
        },
        id: null,
      });
    });

    it('returns 405 Method Not Allowed for DELETE on the MCP endpoint', async () => {
      const session = await open(owner);

      const response = await as(harness, owner).del(
        `${base()}/${session.runId}/mcp`,
      );

      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('POST');
      expect(response.body).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32_000,
          message: 'Method Not Allowed',
        },
        id: null,
      });
    });

    it('does not shadow the application close route with the MCP 405 DELETE handler', async () => {
      const session = await open(owner);

      const response = await as(harness, owner).del(
        `${base()}/${session.runId}`,
      );

      expect(response.status).toBe(200);
      expect((response.body as { data: unknown }).data).toMatchObject({
        closedBy: 'client',
      });
    });

    it('does not crash when the Host header is malformed', async () => {
      const session = await open(owner);

      const { client, close } = await clientFor(
        owner,
        session.runId,
        organizationId,
        { headers: { Host: '[bad' } },
      );

      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
      await close();
    });

    it('refuses subscriptions/listen immediately with a 400 bad request', async () => {
      const session = await open(owner);

      const response = await as(harness, owner)
        .post(`${base()}/${session.runId}/mcp`)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'subscriptions/listen',
          params: {},
        });

      expect(response.status).toBe(400);
      expect(errorBody(response).error?.details).toMatchObject({
        reason: 'method_not_supported',
      });
    });

    it('fails closed when receiving a legacy JSON-RPC batch', async () => {
      const session = await open(owner);

      const response = await as(harness, owner)
        .post(`${base()}/${session.runId}/mcp`)
        .send([
          { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        ]);

      expect([400, 200]).toContain(response.status);
      const body = response.body as
        { error?: { code: number } } | { error?: { code: number } }[];
      if (Array.isArray(body)) {
        expect(body[0]?.error).toBeDefined();
      } else {
        expect(body.error).toBeDefined();
      }
    });

    it('refuses exchanges if the operator disables the agent after session acceptance', async () => {
      const { user, runId } = await openSession();

      await harness.prisma.organizationAgentVersion.updateMany({
        where: { organizationId, installationId },
        data: { enabled: false },
      });

      try {
        const response = await as(harness, user)
          .post(`${base()}/${runId}/mcp`)
          .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

        expect(response.status).toBe(409);
        expect(errorBody(response).error?.details).toMatchObject({
          reason: 'session_agent_unavailable',
        });
      } finally {
        await harness.prisma.organizationAgentVersion.updateMany({
          where: { organizationId, installationId },
          data: { enabled: true },
        });
      }
    });

    it('preserves pinned version and grants across subsequent installation changes', async () => {
      const { user, runId } = await openSession();

      const runBefore = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
        select: { organizationAgentVersionId: true },
      });

      const newVersion = await harness.prisma.organizationAgentVersion.create({
        data: {
          organizationId,
          installationId,
          revision: 99,
          definitionVersion: 1,
          enabled: true,
          toolGrants: [],
          configuration: {},
        },
        select: { id: true },
      });
      await harness.prisma.organizationAgentInstallation.update({
        where: { id: installationId },
        data: { activeVersionId: newVersion.id },
      });

      try {
        const runAfter = await harness.prisma.agentRun.findUniqueOrThrow({
          where: { id: runId },
          select: { organizationAgentVersionId: true },
        });
        expect(runAfter.organizationAgentVersionId).toBe(
          runBefore.organizationAgentVersionId,
        );

        const { client, close } = await clientFor(user, runId);
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toContain('knowledge_search_v1');
        await close();
      } finally {
        await harness.prisma.organizationAgentInstallation.update({
          where: { id: installationId },
          data: { activeVersionId: runBefore.organizationAgentVersionId },
        });
      }
    });
  });
});
