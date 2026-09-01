import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { Client } from 'pg';
import { z } from 'zod';

import { AgentDefinitionRegistry } from '../../src/agents/agent-definition.registry';
import { AgentRunner } from '../../src/agents/agent-runner.service';
import { AgentRunService } from '../../src/agents/agent-run.service';
import { OrganizationAgentInstallationService } from '../../src/agents/organization-agent-installation.service';
import type {
  AgentDefinition,
  AgentRuntimeTool,
} from '../../src/agents/agent.types';
import { ToolExecutionService } from '../../src/agents/tools/tool-execution.service';
import { ToolGateway } from '../../src/agents/tools/tool.gateway';
import { ToolRegistry } from '../../src/agents/tools/tool.registry';
import { APPLICATION_TOOL_DEFINITIONS } from '../../src/agents/tools/definitions';
import type { ToolImplementation } from '../../src/agents/tools/tool.types';
import { MODEL_IDS } from '../../src/model-catalog/model-catalog';
import {
  as,
  createHarness,
  createUser,
  type Harness,
  type TestUser,
} from '../support/auth-harness';

const TOOL_AGENT_ID = 'tool-only-agent';
const REF = 'knowledge.search@1';

/**
 * A test-only definition, deliberately not registered in the production
 * catalog. TOOL-01 must prove tool execution without inventing a product agent
 * whose only purpose is to have tools.
 */
const toolAgent = (
  version: number,
  maxToolGrants?: readonly string[],
): AgentDefinition => ({
  id: TOOL_AGENT_ID,
  version,
  runtime: 'mastra',
  instructions: `Tool-enabled test agent revision ${version}.`,
  model: MODEL_IDS.openAiGpt4oMini,
  modelPolicy: {
    id: `${TOOL_AGENT_ID}.model-policy.${version}`,
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  input: z.unknown(),
  output: z.unknown(),
  organizationConfiguration: {
    schema: z.object({}).strict(),
    defaultValue: {},
  },
  ...(maxToolGrants ? { maxToolGrants: maxToolGrants as never } : {}),
});

/** v1 permits the tool; v2 permits nothing. */
const TOOL_AGENT_DEFINITIONS = [toolAgent(1, [REF]), toolAgent(2)] as const;

describe('governed tool execution', () => {
  let harness: Harness;
  let owner: TestUser;
  let outsider: TestUser;
  let organizationId: string;
  let otherOrganizationId: string;
  let installations: OrganizationAgentInstallationService;
  let runs: AgentRunService;
  let durable: ToolExecutionService;

  const ownedOrganizationIds: string[] = [];

  /** What the tool implementation returns; swapped per test. */
  const succeeding: ToolImplementation['execute'] = () =>
    Promise.resolve({ passages: [{ space: 'brand', content: 'Be concise.' }] });
  let implementation: ToolImplementation['execute'] = succeeding;

  // Reset, so a test that installs a failing implementation cannot decide the
  // outcome of whichever test happens to run after it.
  beforeEach(() => {
    implementation = succeeding;
  });

  const gateway = () =>
    new ToolGateway(new ToolRegistry(APPLICATION_TOOL_DEFINITIONS), durable, [
      { ref: REF, execute: (input, context) => implementation(input, context) },
    ]);

  /** A runtime that calls every tool it was given, then answers. */
  const callingRuntime = (calls: AgentRuntimeTool[][]) => ({
    resolve: () => ({
      name: 'mastra' as const,
      run: async (request: { tools: readonly AgentRuntimeTool[] }) => {
        calls.push([...request.tools]);
        for (const tool of request.tools) {
          await tool.execute({ query: 'brand tone' });
        }
        return { output: 'done' };
      },
    }),
  });

  const runnerWith = (calls: AgentRuntimeTool[][]) =>
    new AgentRunner(
      new AgentDefinitionRegistry(TOOL_AGENT_DEFINITIONS),
      callingRuntime(calls) as never,
      { assemble: () => Promise.resolve([]) } as never,
      runs,
      gateway(),
    );

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

  /** Installs the tool agent, selecting the given grants. */
  const install = async (
    target: string,
    actor: string,
    toolGrants: string[],
    definitionVersion = 1,
  ) =>
    installations.create(
      target,
      {
        agentId: TOOL_AGENT_ID,
        definitionVersion,
        enabled: true,
        toolGrants: toolGrants as never,
      },
      actor,
    );

  /**
   * A terminal run, written directly.
   *
   * `SUCCEEDED` on purpose: a non-terminal row would be swept by the global
   * agent-run reconciler and would change another suite's expectations.
   */
  const acceptedRun = async (input: {
    organizationId: string;
    organizationAgentVersionId: string;
    agentVersion?: number;
  }) =>
    harness.prisma.agentRun.create({
      data: {
        agentId: TOOL_AGENT_ID,
        agentVersion: input.agentVersion ?? 1,
        runtime: 'mastra',
        status: 'SUCCEEDED',
        organizationId: input.organizationId,
        organizationAgentVersionId: input.organizationAgentVersionId,
        input: { question: 'tone' },
        attemptCount: 1,
        idempotencyKey: `tool-${Math.random().toString(36).slice(2)}`,
      },
      select: { id: true, attemptCount: true },
    });

  const executionsFor = (agentRunId: string) =>
    harness.prisma.toolExecution.findMany({
      where: { agentRunId },
      orderBy: { startedAt: 'asc' },
    });

  beforeAll(async () => {
    harness = await createHarness();
    /**
     * Built against this suite's own registry, not the container's.
     *
     * The production catalog deliberately contains no tool-enabled agent, so
     * resolving the service from the app would install nothing this suite can
     * exercise. This is the same fixture pattern the agent-run suite uses.
     */
    installations = new OrganizationAgentInstallationService(
      harness.prisma,
      new AgentDefinitionRegistry(TOOL_AGENT_DEFINITIONS),
    );
    runs = harness.app.get(AgentRunService);
    /**
     * Constructed directly rather than resolved from the container.
     *
     * `AgentToolsModule` belongs to the worker composition, and this harness
     * boots the API root. Reaching for `app.get` here would be asserting a
     * wiring that deliberately does not exist.
     */
    durable = new ToolExecutionService(harness.prisma);

    owner = await createUser(harness);
    outsider = await createUser(harness);
    organizationId = await createOrganization(owner, 'tools-acme');
    otherOrganizationId = await createOrganization(outsider, 'tools-other');
  });

  afterAll(async () => {
    // This suite's runs, and the executions that hang off them. Left behind,
    // the runs would be swept by the reconciler in whatever suite follows.
    for (const id of ownedOrganizationIds) {
      await harness.prisma.toolExecution.deleteMany({
        where: { organizationId: id },
      });
      await harness.prisma.agentRun.deleteMany({
        where: { organizationId: id },
      });
    }
    await harness.close();
  });

  describe('organization grant selection', () => {
    it('refuses a tool outside the definition maximum', async () => {
      const other = await createOrganization(owner, 'tools-outside-max');

      await expect(install(other, owner.id, [REF], 2)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('refuses an unknown tool in grant selection', async () => {
      const other = await createOrganization(owner, 'tools-unknown');

      await expect(
        installations.create(
          other,
          {
            agentId: TOOL_AGENT_ID,
            definitionVersion: 1,
            enabled: true,
            toolGrants: ['invented@1'] as never,
          },
          owner.id,
        ),
      ).rejects.toBeDefined();
    });

    it('persists the selection immutably and reports it', async () => {
      const other = await createOrganization(owner, 'tools-persisted');
      const installed = await install(other, owner.id, [REF]);

      expect(installed.activeVersion.toolGrants).toEqual([REF]);

      const stored =
        await harness.prisma.organizationAgentVersion.findUniqueOrThrow({
          where: { id: installed.activeVersionId },
          select: { toolGrants: true },
        });

      expect(stored.toolGrants).toEqual([REF]);
    });

    it('defaults an unmentioned selection to no tools', async () => {
      const other = await createOrganization(owner, 'tools-defaulted');
      const installed = await installations.create(
        other,
        { agentId: TOOL_AGENT_ID, definitionVersion: 1, enabled: true },
        owner.id,
      );

      expect(installed.activeVersion.toolGrants).toEqual([]);
    });

    it('publishes a new immutable version for a grant-only change', async () => {
      const other = await createOrganization(owner, 'tools-grant-change');
      const installed = await install(other, owner.id, []);

      const replaced = await installations.replace(
        other,
        installed.id,
        {
          expectedRevision: installed.revision,
          definitionVersion: 1,
          enabled: true,
          configuration: {},
          toolGrants: [REF] as never,
        },
        owner.id,
      );

      expect(replaced.activeVersionId).not.toBe(installed.activeVersionId);
      expect(replaced.activeVersion.toolGrants).toEqual([REF]);
    });
  });

  describe('durable execution', () => {
    it('records STARTED then SUCCEEDED with the exact identity and values', async () => {
      const other = await createOrganization(owner, 'tools-durable');
      const installed = await install(other, owner.id, [REF]);
      const run = await acceptedRun({
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
      });

      const calls: AgentRuntimeTool[][] = [];
      await runnerWith(calls).run({
        id: run.id,
        agentId: TOOL_AGENT_ID,
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
        modelPolicyId: null,
        modelId: null,
        modelPricingRevisionId: null,
        attemptCount: 1,
        input: { question: 'tone' },
        createdAt: new Date(),
      });

      const [execution, ...rest] = await executionsFor(run.id);

      expect(rest).toEqual([]);
      expect(execution).toMatchObject({
        organizationId: other,
        agentRunId: run.id,
        agentRunAttempt: 1,
        // The durable identity, not the model-facing runtime name.
        toolId: 'knowledge.search',
        toolVersion: 1,
        status: 'SUCCEEDED',
        input: { query: 'brand tone' },
        output: { passages: [{ space: 'brand', content: 'Be concise.' }] },
        failureCode: null,
      });
      expect(execution?.completedAt).not.toBeNull();
      expect(execution?.completedAt?.getTime()).toBeGreaterThanOrEqual(
        execution?.startedAt.getTime() ?? 0,
      );
    });

    it('records FAILED with a closed code and no provider text', async () => {
      const other = await createOrganization(owner, 'tools-failure');
      const installed = await install(other, owner.id, [REF]);
      const run = await acceptedRun({
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
      });

      const secret = 'postgres://user:hunter2@db/app timed out';
      implementation = () => Promise.reject(new Error(secret));

      await expect(
        runnerWith([]).run({
          id: run.id,
          agentId: TOOL_AGENT_ID,
          agentVersion: 1,
          runtime: 'mastra',
          organizationId: other,
          organizationAgentVersionId: installed.activeVersionId,
          modelPolicyId: null,
          modelId: null,
          modelPricingRevisionId: null,
          attemptCount: 1,
          input: { question: 'tone' },
          createdAt: new Date(),
        }),
      ).rejects.toBeDefined();

      const [execution] = await executionsFor(run.id);

      expect(execution).toMatchObject({
        status: 'FAILED',
        failureCode: 'implementation_error',
        output: null,
      });
      expect(JSON.stringify(execution)).not.toContain('hunter2');
    });

    it('writes nothing at all for a run that was granted no tools', async () => {
      const other = await createOrganization(owner, 'tools-denied');
      const installed = await install(other, owner.id, []);
      const run = await acceptedRun({
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
      });

      const calls: AgentRuntimeTool[][] = [];
      await runnerWith(calls).run({
        id: run.id,
        agentId: TOOL_AGENT_ID,
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
        modelPolicyId: null,
        modelId: null,
        modelPricingRevisionId: null,
        attemptCount: 1,
        input: { question: 'tone' },
        createdAt: new Date(),
      });

      expect(calls[0]).toEqual([]);
      expect(await executionsFor(run.id)).toEqual([]);
    });
  });

  describe('grant pinning', () => {
    /**
     * Both directions of the same property: the run points at an immutable
     * version, and publishing a newer one creates a different row rather than
     * editing the one the run named.
     */
    it('keeps a grant the organization later removed', async () => {
      const other = await createOrganization(owner, 'tools-pin-removed');
      const installed = await install(other, owner.id, [REF]);
      const run = await acceptedRun({
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
      });

      await installations.replace(
        other,
        installed.id,
        {
          expectedRevision: installed.revision,
          definitionVersion: 1,
          enabled: true,
          configuration: {},
          toolGrants: [] as never,
        },
        owner.id,
      );

      const calls: AgentRuntimeTool[][] = [];
      await runnerWith(calls).run({
        id: run.id,
        agentId: TOOL_AGENT_ID,
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
        modelPolicyId: null,
        modelId: null,
        modelPricingRevisionId: null,
        attemptCount: 1,
        input: { question: 'tone' },
        createdAt: new Date(),
      });

      expect(calls[0]?.map((tool) => tool.name)).toEqual([
        'knowledge_search_v1',
      ]);
    });

    it('does not confer a grant the organization added later', async () => {
      const other = await createOrganization(owner, 'tools-pin-added');
      const installed = await install(other, owner.id, []);
      const run = await acceptedRun({
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
      });

      await installations.replace(
        other,
        installed.id,
        {
          expectedRevision: installed.revision,
          definitionVersion: 1,
          enabled: true,
          configuration: {},
          toolGrants: [REF] as never,
        },
        owner.id,
      );

      const calls: AgentRuntimeTool[][] = [];
      await runnerWith(calls).run({
        id: run.id,
        agentId: TOOL_AGENT_ID,
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
        modelPolicyId: null,
        modelId: null,
        modelPricingRevisionId: null,
        attemptCount: 1,
        input: { question: 'tone' },
        createdAt: new Date(),
      });

      expect(calls[0]).toEqual([]);
      expect(await executionsFor(run.id)).toEqual([]);
    });
  });

  describe('tenancy', () => {
    /**
     * Asks PostgreSQL directly rather than the service, because the service
     * check is not what makes a cross-tenant execution impossible — the
     * composite foreign key on `(agentRunId, organizationId)` is.
     */
    it('is refused by PostgreSQL when the application is bypassed', async () => {
      const installed = await install(organizationId, owner.id, [REF]);
      const run = await acceptedRun({
        organizationId,
        organizationAgentVersionId: installed.activeVersionId,
      });

      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();

      try {
        await expect(
          client.query(
            `INSERT INTO "tool_execution"
               ("id","organizationId","agentRunId","agentRunAttempt",
                "toolId","toolVersion","status","input","startedAt",
                "createdAt","updatedAt")
             VALUES ($1,$2,$3,1,'knowledge.search',1,'STARTED','{}',NOW(),NOW(),NOW())`,
            [
              `cross-tenant-${Date.now()}`,
              // The other organization, pointing at this one's run.
              otherOrganizationId,
              run.id,
            ],
          ),
          // The constraint, not just the SQLSTATE. A 23503 from the plain
          // organization foreign key would satisfy `code` alone and would
          // prove nothing about the composite this test exists for.
        ).rejects.toMatchObject({
          code: '23503',
          constraint: 'tool_execution_agentRunId_organizationId_fkey',
        });
      } finally {
        await client.end();
      }
    });

    it('accepts the same insert for the run own organization', async () => {
      const installed = await install(
        await createOrganization(owner, 'tools-control'),
        owner.id,
        [REF],
      );
      const version =
        await harness.prisma.organizationAgentVersion.findUniqueOrThrow({
          where: { id: installed.activeVersionId },
          select: { organizationId: true },
        });
      const run = await acceptedRun({
        organizationId: version.organizationId,
        organizationAgentVersionId: installed.activeVersionId,
      });

      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();

      try {
        await expect(
          client.query(
            `INSERT INTO "tool_execution"
               ("id","organizationId","agentRunId","agentRunAttempt",
                "toolId","toolVersion","status","input","startedAt",
                "createdAt","updatedAt")
             VALUES ($1,$2,$3,1,'knowledge.search',1,'STARTED','{}',NOW(),NOW(),NOW())`,
            [`control-${Date.now()}`, version.organizationId, run.id],
          ),
        ).resolves.toBeDefined();
      } finally {
        await client.end();
      }
    });
  });

  describe('durable detail', () => {
    /**
     * A retried run performs its tools again, and two executions of one tool
     * for one run are distinguishable only by this number.
     */
    it('records the run attempt it actually executed under', async () => {
      const other = await createOrganization(owner, 'tools-attempt');
      const installed = await install(other, owner.id, [REF]);
      const run = await acceptedRun({
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
      });

      await runnerWith([]).run({
        id: run.id,
        agentId: TOOL_AGENT_ID,
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
        modelPolicyId: null,
        modelId: null,
        modelPricingRevisionId: null,
        attemptCount: 3,
        input: { question: 'tone' },
        createdAt: new Date(),
      });

      const [execution] = await executionsFor(run.id);

      expect(execution?.agentRunAttempt).toBe(3);
    });

    it('records output_rejected against the real database', async () => {
      const other = await createOrganization(owner, 'tools-output-rejected');
      const installed = await install(other, owner.id, [REF]);
      const run = await acceptedRun({
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
      });

      implementation = () => Promise.resolve({ passages: 'not-an-array' });

      await expect(
        runnerWith([]).run({
          id: run.id,
          agentId: TOOL_AGENT_ID,
          agentVersion: 1,
          runtime: 'mastra',
          organizationId: other,
          organizationAgentVersionId: installed.activeVersionId,
          modelPolicyId: null,
          modelId: null,
          modelPricingRevisionId: null,
          attemptCount: 1,
          input: { question: 'tone' },
          createdAt: new Date(),
        }),
      ).rejects.toBeDefined();

      const [execution] = await executionsFor(run.id);

      expect(execution).toMatchObject({
        status: 'FAILED',
        failureCode: 'output_rejected',
        output: null,
      });
    });

    /** The tenant predicate on the update side, at row level. */
    it('will not complete an execution for another organization', async () => {
      const other = await createOrganization(owner, 'tools-update-scope');
      const installed = await install(other, owner.id, [REF]);
      const run = await acceptedRun({
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
      });

      const id = await durable.start({
        organizationId: other,
        agentRunId: run.id,
        agentRunAttempt: 1,
        toolId: 'knowledge.search',
        toolVersion: 1,
        input: { query: 'tone' },
      });

      await durable.succeed(id, otherOrganizationId, { passages: [] });

      const row = await harness.prisma.toolExecution.findUniqueOrThrow({
        where: { id },
      });

      expect(row.status).toBe('STARTED');
      expect(row.completedAt).toBeNull();
    });
  });

  describe('two durable facts that disagree', () => {
    /**
     * Only reachable by a direct write or an in-place definition edit, which is
     * exactly why the application-level tests cannot reach it. A stored grant
     * outside the pinned definition's maximum is refused rather than
     * intersected away, and deterministically so.
     */
    it('refuses a run whose stored grant exceeds its definition maximum', async () => {
      const other = await createOrganization(owner, 'tools-disagree');
      // Installed against v2, which permits no tools, then granted behind the
      // service's back.
      const installed = await install(other, owner.id, [], 2);
      await harness.prisma.organizationAgentVersion.update({
        where: { id: installed.activeVersionId },
        data: { toolGrants: [REF] },
      });
      const run = await acceptedRun({
        organizationId: other,
        organizationAgentVersionId: installed.activeVersionId,
        agentVersion: 2,
      });

      await expect(
        runnerWith([]).run({
          id: run.id,
          agentId: TOOL_AGENT_ID,
          agentVersion: 2,
          runtime: 'mastra',
          organizationId: other,
          organizationAgentVersionId: installed.activeVersionId,
          modelPolicyId: null,
          modelId: null,
          modelPricingRevisionId: null,
          attemptCount: 1,
          input: { question: 'tone' },
          createdAt: new Date(),
        }),
      ).rejects.toThrow('outside its definition maximum');

      expect(await executionsFor(run.id)).toEqual([]);
    });

    it('refuses a duplicated grant at selection', async () => {
      const other = await createOrganization(owner, 'tools-duplicate');

      await expect(
        installations.create(
          other,
          {
            agentId: TOOL_AGENT_ID,
            definitionVersion: 1,
            enabled: true,
            toolGrants: [REF, REF] as never,
          },
          owner.id,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    /**
     * The migration's rollback argument, as a test rather than as a comment:
     * a row written by an image that does not know the column exists means
     * what an empty grant list means.
     */
    it('treats a version written without the column as granting nothing', async () => {
      const other = await createOrganization(owner, 'tools-legacy-row');
      const installed = await install(other, owner.id, [REF]);

      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      const legacyId = `legacy-${Date.now()}`;

      try {
        await client.query(
          `INSERT INTO "organization_agent_version"
             ("id","organizationId","installationId","revision",
              "definitionVersion","enabled","configuration","createdAt")
           VALUES ($1,$2,$3,99,1,true,'{}',NOW())`,
          [legacyId, other, installed.id],
        );
      } finally {
        await client.end();
      }

      const stored =
        await harness.prisma.organizationAgentVersion.findUniqueOrThrow({
          where: { id: legacyId },
          select: { toolGrants: true },
        });

      expect(stored.toolGrants).toEqual([]);

      const run = await acceptedRun({
        organizationId: other,
        organizationAgentVersionId: legacyId,
      });
      const calls: AgentRuntimeTool[][] = [];

      await runnerWith(calls).run({
        id: run.id,
        agentId: TOOL_AGENT_ID,
        agentVersion: 1,
        runtime: 'mastra',
        organizationId: other,
        organizationAgentVersionId: legacyId,
        modelPolicyId: null,
        modelId: null,
        modelPricingRevisionId: null,
        attemptCount: 1,
        input: { question: 'tone' },
        createdAt: new Date(),
      });

      expect(calls[0]).toEqual([]);
    });
  });
});
