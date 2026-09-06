import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { inspect } from 'node:util';
import { Client } from 'pg';
import { z } from 'zod';

import { AgentDefinitionRegistry } from '../../../src/ai/agents/agent-definition.registry';
import { AgentRunner } from '../../../src/ai/execution/agent-runner.service';
import { AgentRunService } from '../../../src/ai/execution/agent-run.service';
import { OrganizationAgentInstallationService } from '../../../src/features/agent-management/organization-agent-installation.service';
import type {
  AgentDefinition,
  AgentRuntimeTool,
} from '../../../src/ai/agents/agent.types';
import {
  ToolExecutionService,
  ToolExecutionTransitionError,
} from '../../../src/ai/tools/tool-execution.service';
import {
  ToolExecutionFailure,
  ToolGateway,
} from '../../../src/ai/tools/tool.gateway';
import { ToolRegistry } from '../../../src/ai/tools/tool.registry';
import { APPLICATION_TOOL_DEFINITIONS } from '../../../src/features/agent-management/tools/definitions';
import type { ToolImplementation } from '../../../src/ai/tools/tool.types';
import { MODEL_IDS } from '../../../src/ai/models/model-catalog';
import {
  as,
  createHarness,
  createUser,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

const TOOL_AGENT_ID = 'tool-only-agent';
const REF = 'knowledge.search@1';

const sideEffectStub = {
  ref: 'notification.send@1' as const,
  kind: 'side_effect' as const,
  propose: () => Promise.resolve(),
  prepareEffect: () => Promise.reject(new Error('never')),
};

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

  const succeeding: ToolImplementation['execute'] = () =>
    Promise.resolve({ passages: [{ space: 'brand', content: 'Be concise.' }] });
  let implementation: ToolImplementation['execute'] = succeeding;

  beforeEach(() => {
    implementation = succeeding;
  });

  const gateway = () =>
    new ToolGateway(new ToolRegistry(APPLICATION_TOOL_DEFINITIONS), durable, [
      { ref: REF, execute: (input, context) => implementation(input, context) },
      sideEffectStub,
    ]);

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
      { assemble: () => Promise.resolve([]) },
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
    installations = new OrganizationAgentInstallationService(
      harness.prisma,
      new AgentDefinitionRegistry(TOOL_AGENT_DEFINITIONS),
    );
    runs = harness.app.get(AgentRunService);
    durable = new ToolExecutionService(harness.prisma);

    owner = await createUser(harness);
    outsider = await createUser(harness);
    organizationId = await createOrganization(owner, 'tools-acme');
    otherOrganizationId = await createOrganization(outsider, 'tools-other');
  });

  afterAll(async () => {
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
            [`cross-tenant-${Date.now()}`, otherOrganizationId, run.id],
          ),
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

      await expect(
        durable.succeed(id, otherOrganizationId, { passages: [] }),
      ).rejects.toBeInstanceOf(ToolExecutionTransitionError);

      const row = await harness.prisma.toolExecution.findUniqueOrThrow({
        where: { id },
      });

      expect(row.status).toBe('STARTED');
      expect(row.completedAt).toBeNull();
    });
  });

  describe('terminal transitions', () => {
    let transitionOrganizationId: string;
    let transitionRunId: string;

    beforeAll(async () => {
      transitionOrganizationId = await createOrganization(
        owner,
        'tools-transitions',
      );
      const installed = await install(transitionOrganizationId, owner.id, [
        REF,
      ]);
      const run = await acceptedRun({
        organizationId: transitionOrganizationId,
        organizationAgentVersionId: installed.activeVersionId,
      });
      transitionRunId = run.id;
    });

    const started = () =>
      durable.start({
        organizationId: transitionOrganizationId,
        agentRunId: transitionRunId,
        agentRunAttempt: 1,
        toolId: 'knowledge.search',
        toolVersion: 1,
        input: { query: 'tone' },
      });

    const row = (id: string) =>
      harness.prisma.toolExecution.findUniqueOrThrow({ where: { id } });

    it('settles STARTED -> SUCCEEDED exactly once', async () => {
      const id = await started();

      await expect(
        durable.succeed(id, transitionOrganizationId, { passages: [] }),
      ).resolves.toBeUndefined();

      const first = await row(id);

      expect(first.status).toBe('SUCCEEDED');
      expect(first.completedAt).not.toBeNull();

      await expect(
        durable.succeed(id, transitionOrganizationId, {
          passages: ['rewritten'],
        }),
      ).rejects.toBeInstanceOf(ToolExecutionTransitionError);

      const second = await row(id);

      expect(second.status).toBe('SUCCEEDED');
      expect(second.output).toEqual({ passages: [] });
      expect(second.completedAt).toEqual(first.completedAt);
    });

    it('settles STARTED -> FAILED exactly once', async () => {
      const id = await started();

      await expect(
        durable.fail(id, transitionOrganizationId, 'implementation_error'),
      ).resolves.toBeUndefined();

      const first = await row(id);

      expect(first.status).toBe('FAILED');
      expect(first.failureCode).toBe('implementation_error');

      await expect(
        durable.fail(id, transitionOrganizationId, 'output_rejected'),
      ).rejects.toBeInstanceOf(ToolExecutionTransitionError);

      const second = await row(id);

      expect(second.failureCode).toBe('implementation_error');
      expect(second.completedAt).toEqual(first.completedAt);
    });

    it('will not turn a SUCCEEDED execution into a FAILED one', async () => {
      const id = await started();
      await durable.succeed(id, transitionOrganizationId, { passages: [] });

      await expect(
        durable.fail(id, transitionOrganizationId, 'implementation_error'),
      ).rejects.toBeInstanceOf(ToolExecutionTransitionError);

      const settled = await row(id);

      expect(settled.status).toBe('SUCCEEDED');
      expect(settled.failureCode).toBeNull();
    });

    it('will not turn a FAILED execution into a SUCCEEDED one', async () => {
      const id = await started();
      await durable.fail(id, transitionOrganizationId, 'implementation_error');

      await expect(
        durable.succeed(id, transitionOrganizationId, { passages: [] }),
      ).rejects.toBeInstanceOf(ToolExecutionTransitionError);

      const settled = await row(id);

      expect(settled.status).toBe('FAILED');
      expect(settled.output).toBeNull();
    });

    it('refuses a terminal write for an execution that does not exist', async () => {
      await expect(
        durable.succeed(
          '00000000-0000-4000-8000-000000000000',
          transitionOrganizationId,
          { passages: [] },
        ),
      ).rejects.toBeInstanceOf(ToolExecutionTransitionError);
    });

    it('does not let the gateway answer when no row transitioned', async () => {
      const id = await started();
      await durable.succeed(id, transitionOrganizationId, { passages: [] });

      const stuck = new ToolExecutionService(harness.prisma);
      const tools = new ToolGateway(
        new ToolRegistry(APPLICATION_TOOL_DEFINITIONS),
        {
          start: () => Promise.resolve(id),
          succeed: stuck.succeed.bind(stuck),
          fail: stuck.fail.bind(stuck),
        } as never,
        [{ ref: REF, execute: succeeding }, sideEffectStub],
      ).authorize({
        definition: toolAgent(1, [REF]),
        organizationId: transitionOrganizationId,
        agentRunId: transitionRunId,
        agentRunAttempt: 1,
        grants: [REF],
      });

      const failure = await tools[0]?.execute({ query: 'tone' }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ToolExecutionFailure);
      expect((failure as Error).message).toBe(
        'Tool "knowledge_search_v1" could not be completed',
      );
      expect((failure as Error).stack).toBeUndefined();
    });

    it('lets no raw database error out through the tool result', async () => {
      const exploding = {
        start: () => Promise.resolve('execution-1'),
        succeed: () =>
          harness.prisma.toolExecution.create({
            data: { organizationId: null } as never,
          }),
        fail: () => Promise.resolve(),
      };

      const tools = new ToolGateway(
        new ToolRegistry(APPLICATION_TOOL_DEFINITIONS),
        exploding as never,
        [{ ref: REF, execute: succeeding }, sideEffectStub],
      ).authorize({
        definition: toolAgent(1, [REF]),
        organizationId: transitionOrganizationId,
        agentRunId: transitionRunId,
        agentRunAttempt: 1,
        grants: [REF],
      });

      const failure = (await tools[0]?.execute({ query: 'tone' }).then(
        () => null,
        (error: unknown) => error,
      )) as Error;

      expect(failure).toBeInstanceOf(ToolExecutionFailure);
      expect(failure.message).toBe(
        'Tool "knowledge_search_v1" could not be completed',
      );
      expect(failure.stack).toBeUndefined();

      const serialized = inspect(failure, {
        depth: null,
        maxStringLength: null,
      });

      expect(serialized).not.toContain('prisma');
      expect(serialized).not.toContain('toolExecution');
      expect(serialized).not.toContain('organizationId');
      expect(Object.keys(failure)).toEqual([]);
    });
  });

  describe('two durable facts that disagree', () => {
    it('refuses a run whose stored grant exceeds its definition maximum', async () => {
      const other = await createOrganization(owner, 'tools-disagree');
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
