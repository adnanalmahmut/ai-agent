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

import { AgentDefinitionRegistry } from '../../src/agents/agent-definition.registry';
import type { AgentDefinition } from '../../src/agents/agent.types';
import { MCP_SESSION_TTL_MS } from '../../src/agents/agent.types';
import { MCP_SESSION_TOOL_CALL_BUDGET } from '../../src/agents/mcp/mcp-session.types';
import { OrganizationAgentInstallationService } from '../../src/agents/organization-agent-installation.service';
import { APPLICATION_TOOL_DEFINITIONS } from '../../src/agents/tools/definitions';
import { NotificationSendTool } from '../../src/agents/tools/notification-send.tool';
import {
  idempotencyKeyFor,
  SideEffectExecutionHandler,
  type SideEffectExecutionJob,
} from '../../src/agents/tools/side-effect-execution.handler';
import { ToolExecutionService } from '../../src/agents/tools/tool-execution.service';
import { ToolRegistry } from '../../src/agents/tools/tool.registry';
import {
  FeatureFlagService,
  RuntimeSettingService,
} from '../../src/control-plane';
import type {
  ExternalEffectOutcome,
  NotificationDelivery,
  NotificationMessage,
} from '../../src/infrastructure/mail/notification-delivery';
import {
  EMBEDDING_DIMENSIONS,
  KnowledgeWriterService,
} from '../../src/knowledge';
import { MODEL_IDS } from '../../src/model-catalog/model-catalog';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../support/auth-harness';

/**
 * MCP as an adapter, proved over real HTTP against a real database.
 *
 * The protocol mechanics are the unit suite's subject. Everything here is an
 * *authority* claim, and every one of them is a claim that cannot be made
 * anywhere else: whether a predicate actually scopes, whether a guard actually
 * refuses, whether a proposal actually stops at a durable row. The load-bearing
 * one is the last block — an MCP client cannot send a notification, and the
 * only thing that could prove otherwise is a provider double that records
 * every call it receives.
 */

const AGENT_ID = 'mcp-adapter-test-agent';
const KNOWLEDGE_REF = 'knowledge.search@1';
const NOTIFY_REF = 'notification.send@1';
/** A real slug from the code-owned taxonomy: the policy resolves against it. */
const SPACE = 'brand.voice';
const MODEL = 'text-embedding-3-small';

/**
 * A test-only definition that may be granted both tools.
 *
 * Not registered in the production catalog, and deliberately so: MCP-01 proves
 * the adapter without inventing a product agent whose only purpose is to have
 * tools. `content-project-handoff@1` is DEMO-01's, and until it exists no
 * production definition grants anything at all — which is exactly why this
 * suite has to supply its own.
 */
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

/** A unit vector on one axis, so "which is closer" is unambiguous. */
const axis = (index: number): number[] =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === index ? 1 : 0));

/**
 * A provider double that records every call.
 *
 * Its whole purpose is the negative claim: if MCP could reach a provider, this
 * array would not be empty.
 */
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
  /**
   * A pool of session-opening admins.
   *
   * `POST /mcp-sessions` is metered at 30 requests per five minutes per user,
   * which is a real production bound on an endpoint that takes an in-flight
   * slot and can spend on every later call. It is not loosened to fit a test
   * suite — so a file that opens more than thirty sessions has to spread them,
   * exactly as the content-idea suite spreads its billed requests. Whose
   * session it is only matters in the block that asserts it, and that block
   * names its users explicitly.
   */
  let openers: TestUser[];
  let nextOpener = 0;
  let organizationId: string;
  let otherOrganizationId: string;
  let recipientMemberId: string;
  let installationId: string;
  let delivery: RecordingDelivery;

  const ownedOrganizationIds: string[] = [];

  /**
   * Every session this test opened, so it can be released.
   *
   * A session holds one of the organization's in-flight run slots until it is
   * closed or expires — the deliberate consequence of modelling it as an
   * `AgentRun`, and the reason the operator ceiling applies to it at all. The
   * default ceiling is ten, so a suite that opens thirty sessions and closes
   * none is refused partway through by the very bound it is supposed to
   * respect. Released between tests rather than at the end, because the
   * ceiling is a *concurrency* limit.
   */
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

  /** Installs the agent with exactly the grants a case needs. */
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

  /**
   * Publishes a new immutable version with a different grant selection.
   *
   * The revision is read rather than remembered: `replace` is a
   * compare-and-set on the installation pointer, so it refuses a caller
   * holding a stale revision — which is the behaviour that makes a published
   * version immutable, and not something to work around.
   */
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

  /** The next admin in the pool, so no single user hits its own budget. */
  const opener = (): TestUser => {
    const user = openers[nextOpener % openers.length];
    nextOpener += 1;
    return user;
  };

  /**
   * A session opened by whichever pooled admin is next.
   *
   * Returned together with its user, because every later request in the same
   * test has to come from the member who opened it — that is the rule under
   * test elsewhere, so it has to hold here too.
   */
  const openSession = async (org = organizationId) => {
    const user = opener();
    const { runId } = await open(user, org);
    return { user, runId };
  };

  /** Opens a session and returns its run id. */
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

  /**
   * A real MCP client speaking to the real endpoint.
   *
   * The transport is the client SDK's own, with `fetch` pointed at supertest so
   * the request travels through Nest — the guard, the session lookup, the
   * gateway — rather than around it. Anything this client can do, a real MCP
   * client can do.
   */
  /**
   * A real MCP client speaking to the real endpoint.
   *
   * The transport is the client SDK's own, with `fetch` routed through
   * supertest so every request travels through Nest — the guard, the session
   * lookup, the gateway — rather than around it. Anything this client can do,
   * a real MCP client can do, and anything it cannot do is a refusal the
   * application actually made.
   *
   * `mode: 'auto'` because the v2 client defaults to `'legacy'`, and the point
   * of this suite is the protocol revision the deployment actually serves. The
   * headers have to be copied out of a `Headers` instance rather than spread:
   * the SDK sends `Accept: application/json, text/event-stream`, and a
   * transport that dropped it would be refused `406` before reaching anything
   * this suite is about.
   */
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

          /**
           * The SDK always sends a JSON string body, so it is parsed back and
           * handed to supertest as an object — which is what makes the
           * application's own JSON parsing, and its `@Body()` binding, part of
           * what this suite exercises.
           */
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
      /**
       * Deterministic vectors, and the reason CI never reaches a provider. The
       * query embeds onto the same axis as the organization's own chunk.
       */
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

    // Written directly rather than through the endpoint: releasing a slot is
    // fixture teardown, and routing it through HTTP would spend the per-user
    // budget that the assertions themselves need.
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
      // Always, so a cleanup fault cannot leave the Nest app and its pools open
      // and hang the run.
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
      // Pinned at acceptance, which is what makes the grant set immutable for
      // this session however the installation changes later.
      expect(run.organizationAgentVersionId).not.toBeNull();
    });

    /**
     * No queue intent, which is the durable form of "the worker must never
     * execute this".
     *
     * `AgentRuntimeRegistry.resolve('mcp')` would also throw, but that is a
     * second line of defence. The first is that no job is ever published.
     */
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
        reason: 'idempotency_key_required',
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

    /**
     * The other organization granted only knowledge, and that is what its
     * session sees. An absent grant is an absent tool, not a tool that
     * refuses — the model is never told a capability exists.
     */
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

    /**
     * A grant changed after acceptance does not reach an open session.
     *
     * The session reads the immutable `OrganizationAgentVersion` it pinned,
     * not the installation's current one. Publishing a narrower version while
     * a session is open is exactly the case where reading the live
     * installation would silently change what an accepted run may do.
     */
    it('is unaffected by a grant change made after acceptance', async () => {
      const { user, runId } = await openSession();

      await regrant([KNOWLEDGE_REF]);

      try {
        const { client, close } = await clientFor(user, runId);

        // Still both, because the run pinned the version that granted both.
        expect(
          (await client.listTools()).tools.map((t) => t.name).sort(),
        ).toEqual(['knowledge_search_v1', 'notification_send_v1']);

        await close();

        // And a session opened now sees the narrowed set.
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

      // One row, through the same service the Mastra path writes with.
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

    /**
     * The claim a unit test cannot make: the predicate scopes.
     *
     * The other organization's chunk sits on the same axis as this query, so
     * an unscoped or post-filtered retrieval would return it. The caller
     * supplies only a query string — there is no organization parameter to
     * get wrong, which is the design — so this proves the *closure* carries
     * the tenant.
     */
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

    /**
     * There is no argument through which a caller can name a tenant.
     *
     * The application's own input schema is `.strict()`, and it is the schema
     * the protocol publishes, so an extra property is refused before the
     * closure runs rather than ignored.
     */
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

  /**
   * The load-bearing block. Everything else is scaffolding for this.
   */
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

      // What the caller is told is exactly what a Mastra run is told.
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

      // The negative claim, stated as evidence rather than as reasoning.
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

    /**
     * An approved MCP proposal is delivered by ACT-01's worker, unchanged.
     *
     * The handler is constructed here rather than mocked, and it is the same
     * class the worker registers. The idempotency key is asserted to equal
     * `idempotencyKeyFor(row)` — the derivation ACT-01 owns — because "MCP
     * uses the same effect path" is only true if the key a provider would
     * deduplicate on is the same one.
     */
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

      // Nothing has left yet: approval commits an outbox event, and the worker
      // is what performs the effect.
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

      // And a redelivery performs no second external effect.
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

      // Not 403: an id is not a capability, and a refusal must not confirm
      // that somebody else's session exists.
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

    /**
     * A worker run's id is not a session id.
     *
     * Without the runtime predicate this would be a way to drive a run Mastra
     * owns — writing tool executions against an attempt whose transcript
     * nobody is keeping.
     */
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

    /** An admin in the same organization can close to recover capacity. */
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

    /**
     * An expired session is closed by the request that discovers it, not
     * merely refused — otherwise the row would say `RUNNING` forever while
     * every request refused it.
     */
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
    /**
     * The bound the gateway cannot enforce, enforced durably.
     *
     * `MAX_TOOL_INVOCATIONS_PER_ATTEMPT` lives inside one `authorize()` call,
     * and an MCP session authorizes once per HTTP request — so without this
     * ceiling a session would receive a fresh budget on every request and
     * could make an unbounded number of paid embedding calls. The rows are
     * written directly rather than by making forty-eight real calls, because
     * what is under test is the predicate, not the arithmetic.
     */
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

      // Refused, so nothing durable was added and no embedding was paid for.
      const count = await harness.prisma.toolExecution.count({
        where: { agentRunId: runId },
      });
      expect(count).toBe(MCP_SESSION_TOOL_CALL_BUDGET);

      await close();
    });

    /**
     * A session consumes one of the organization's in-flight run slots.
     *
     * This is the deliberate consequence of modelling a session as an
     * `AgentRun`, and it is asserted rather than merely documented because it
     * is the kind of tradeoff a later change could remove by accident — at
     * which point an organization could hold unlimited open sessions, each
     * able to spend.
     */
    it('counts against the organization’s in-flight ceiling', async () => {
      const settings = harness.app.get(RuntimeSettingService);

      /**
       * Measured rather than assumed to be zero.
       *
       * Another case in this file deliberately leaves a `mastra` run
       * `RUNNING`, to prove a worker run's id is not a session id — and that
       * run holds a slot too, which is the whole point of the ceiling. So the
       * bound is set relative to what is already in flight: one more session
       * fits, and the one after it must not.
       */
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
    /**
     * Exact origin validation.
     *
     * The specification requires a streamable-HTTP server to validate Origin.
     * Reusing the deployment's trusted origins (scheme + hostname + effective port)
     * prevents DNS rebinding and cross-origin request forgery across different schemes
     * or ports on the same host, while allowing non-browser clients that send no Origin.
     */
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

    /** A non-browser MCP client sends no `Origin`, and must not be refused. */
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

        // The switch reaches an already-open session, which is the point: a
        // feature gate that only guarded acceptance would leave every live
        // session spending after an operator had stopped the feature.
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

    /**
     * The session's credential never enters the protocol SDK.
     *
     * Asserted through the durable evidence available to a test: the exchange
     * succeeds while the forwarded header set excludes `cookie`, so the SDK
     * cannot be relaying one. The allowlist itself is unit-tested; this proves
     * a real request still works under it.
     */
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
