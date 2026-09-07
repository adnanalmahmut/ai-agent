import { createHash } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import request from 'supertest';

import {
  APPLICATION_MODEL_CATALOG,
  MODEL_IDS,
} from '../../../src/ai/models/model-catalog';
import {
  installTestAgent,
  TEST_AGENT_DEFINITIONS,
  TEST_AGENT_ID,
} from '../../support/agent-run-fixtures';
import { createHarness, type Harness } from '../../support/auth-harness';

const fixtureId = `internal-exec-e2e-${process.pid}`;
const organizationId = `${fixtureId}-org`;
const otherOrganizationId = `${fixtureId}-org-other`;

// Throwaway values. Only their digests are ever configured, and the boundary
// compares digests, so nothing here is a credential the system stores.
const RUNTIME_TOKEN = `${fixtureId}-runtime-token-000000000000`;
const READER_TOKEN = `${fixtureId}-reader-token-0000000000000`;

const digestOf = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const runFor = (id: string) => `/internal/execution/runs/${id}`;

describe('the internal execution boundary (e2e)', () => {
  let harness: Harness;
  let runId: string;

  const seedRun = async (
    organization = organizationId,
    idempotencyKey = `${fixtureId}-${Math.random().toString(36).slice(2)}`,
  ): Promise<string> => {
    const version =
      await harness.prisma.organizationAgentVersion.findFirstOrThrow({
        where: { organizationId: organization },
        select: { id: true },
      });
    const createdAt = new Date();
    const run = await harness.prisma.agentRun.create({
      data: {
        agentId: TEST_AGENT_ID,
        agentVersion: 1,
        runtime: 'mastra',
        status: 'QUEUED',
        organizationId: organization,
        organizationAgentVersionId: version.id,
        // A run is pinned to all three or to none; the boundary refuses a
        // half-populated pin rather than completing it from a default.
        modelPolicyId: `${TEST_AGENT_ID}.model-policy.1`,
        modelId: MODEL_IDS.openAiGpt4oMini,
        modelPricingRevisionId: APPLICATION_MODEL_CATALOG.pricingRevision(
          MODEL_IDS.openAiGpt4oMini,
          createdAt,
        ).id,
        createdAt,
        input: { prompt: 'deterministic test input' },
        idempotencyKey,
      },
      select: { id: true },
    });

    return run.id;
  };

  // Ordered so every restricted reference is gone before its target is.
  const removeFixture = async (id: string): Promise<void> => {
    await harness.prisma.agentRun.deleteMany({ where: { organizationId: id } });
    await harness.prisma.organizationAgentInstallation.updateMany({
      where: { organizationId: id },
      data: { activeVersionId: null },
    });
    await harness.prisma.organizationAgentVersion.deleteMany({
      where: { organizationId: id },
    });
    await harness.prisma.organizationAgentInstallation.deleteMany({
      where: { organizationId: id },
    });
    await harness.prisma.organization.deleteMany({ where: { id } });
  };

  const lease = (id: string, token = RUNTIME_TOKEN) =>
    request(harness.server)
      .post(`${runFor(id)}/lease`)
      .set('Authorization', `Bearer ${token}`);

  const settle = (id: string, token = RUNTIME_TOKEN) =>
    request(harness.server)
      .post(`${runFor(id)}/result`)
      .set('Authorization', `Bearer ${token}`);

  /** The attempt the Control Plane assigned, read once so it stays a number. */
  const attemptOf = (response: { body: unknown }): number => {
    const body = response.body as { data?: { attempt?: unknown } };
    const attempt = body.data?.attempt;

    if (typeof attempt !== 'number') {
      throw new Error('lease response carried no attempt ordinal');
    }

    return attempt;
  };

  const finalResult = (id: string, attempt: number, output: unknown) => ({
    version: '1',
    stepId: `${id}:${attempt}`,
    runId: id,
    attempt,
    outcome: 'final',
    output,
    artifacts: [],
  });

  beforeAll(async () => {
    // Parsed at boot, so it has to be in place before the module compiles.
    process.env.INTERNAL_SERVICE_CREDENTIALS = JSON.stringify([
      {
        serviceId: 'ai-runtime',
        tokenSha256: digestOf(RUNTIME_TOKEN),
        capabilities: ['execution:step.lease', 'execution:step.settle'],
      },
      {
        serviceId: 'step-reader',
        tokenSha256: digestOf(READER_TOKEN),
        capabilities: ['execution:step.lease'],
      },
    ]);

    harness = await createHarness({ definitions: [...TEST_AGENT_DEFINITIONS] });

    for (const id of [organizationId, otherOrganizationId]) {
      await removeFixture(id);
      await harness.prisma.organization.create({
        data: { id, name: `Internal Exec ${id}`, slug: id },
      });
      await installTestAgent(harness.prisma, id);
    }
  });

  afterAll(async () => {
    for (const id of [organizationId, otherOrganizationId]) {
      await removeFixture(id);
    }

    delete process.env.INTERNAL_SERVICE_CREDENTIALS;
    await harness.close();
  });

  beforeEach(async () => {
    runId = await seedRun();
  });

  describe('authentication', () => {
    it('refuses a request with no credential', async () => {
      await request(harness.server)
        .post(`${runFor(runId)}/lease`)
        .expect(401);
    });

    it('refuses an unknown credential', async () => {
      await lease(runId, 'not-a-configured-token-000000').expect(401);
    });

    it('refuses a credential presented as its own digest', async () => {
      await lease(runId, digestOf(RUNTIME_TOKEN)).expect(401);
    });

    it('cannot be satisfied by naming a service in a header', async () => {
      await request(harness.server)
        .post(`${runFor(runId)}/lease`)
        .set('X-Service-Name', 'ai-runtime')
        .set('X-Internal-Service', 'ai-runtime')
        .expect(401);
    });
  });

  describe('authorization', () => {
    it('lets a service do what its capabilities say', async () => {
      await lease(runId, READER_TOKEN).expect(201);
    });

    it('refuses the operation the same identity does not hold', async () => {
      const leased = await lease(runId).expect(201);

      await settle(runId, READER_TOKEN)
        .send(finalResult(runId, attemptOf(leased), { answer: 'ok' }))
        .expect(403);
    });
  });

  describe('scoping', () => {
    it('serialises the step from durable state', async () => {
      const response = await lease(runId).expect(201);

      expect(response.body.data).toMatchObject({
        version: '1',
        stepId: `${runId}:1`,
        runId,
        organizationId,
        attempt: 1,
        agent: { id: TEST_AGENT_ID, version: 1 },
        input: { prompt: 'deterministic test input' },
        context: [],
        grantedTools: [],
      });
      expect(response.body.data.model.modelId).toBe(MODEL_IDS.openAiGpt4oMini);
    });

    it('answers an unknown run the way it answers another tenant’s run', async () => {
      const foreign = await seedRun(otherOrganizationId);

      await lease(`${fixtureId}-absent`).expect(404);
      await request(harness.server)
        .post(`${runFor(foreign)}/lease`)
        .set('Authorization', `Bearer ${RUNTIME_TOKEN}`)
        .set('X-Assert-Organization-Id', organizationId)
        .expect(404);

      const untouched = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: foreign },
        select: { status: true, attemptCount: true },
      });
      expect(untouched).toEqual({ status: 'QUEUED', attemptCount: 0 });
    });

    it('accepts a tenant assertion that agrees with durable state', async () => {
      await request(harness.server)
        .post(`${runFor(runId)}/lease`)
        .set('Authorization', `Bearer ${RUNTIME_TOKEN}`)
        .set('X-Assert-Organization-Id', organizationId)
        .expect(201);
    });

    it('will not lease a run that has reached a terminal state', async () => {
      await harness.prisma.agentRun.update({
        where: { id: runId },
        data: { status: 'SUCCEEDED', attemptCount: 1 },
      });

      await lease(runId).expect(409);
    });
  });

  describe('contract validation', () => {
    it('rejects a malformed result and says where', async () => {
      const response = await settle(runId)
        .send({ version: '1', outcome: 'final' })
        .expect(400);

      expect(response.body.error.details.reason).toBe('contract_violation');
      expect(response.body.error.details.issues.length).toBeGreaterThan(0);
    });

    it('rejects a result written against another contract version', async () => {
      const leased = await lease(runId).expect(201);

      await settle(runId)
        .send({
          ...finalResult(runId, attemptOf(leased), { answer: 'ok' }),
          version: '2',
        })
        .expect(400);
    });

    it('rejects a result that claims it was approved', async () => {
      const leased = await lease(runId).expect(201);

      await settle(runId)
        .send({
          ...finalResult(runId, attemptOf(leased), { answer: 'ok' }),
          approved: true,
        })
        .expect(400);
    });

    it('rejects a credential-shaped property nested in the output', async () => {
      const leased = await lease(runId).expect(201);

      await settle(runId)
        .send(
          finalResult(runId, attemptOf(leased), {
            nested: { api_key: 'sk-live-000' },
          }),
        )
        .expect(400);
    });

    it('rejects a result whose step identity is not the run in the route', async () => {
      const other = await seedRun();
      const leased = await lease(runId).expect(201);

      await settle(runId)
        .send({
          ...finalResult(runId, attemptOf(leased), { answer: 'ok' }),
          stepId: `${other}:1`,
        })
        .expect(400);
    });
  });

  describe('fencing and replay', () => {
    it('applies a valid result once', async () => {
      const leased = await lease(runId).expect(201);
      const document = finalResult(runId, attemptOf(leased), {
        answer: 'thirty days',
      });

      const response = await settle(runId).send(document).expect(201);
      expect(response.body.data.status).toBe('settled');

      const stored = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, output: true },
      });
      expect(stored).toEqual({
        status: 'SUCCEEDED',
        output: { answer: 'thirty days' },
      });
    });

    it('treats a replay of the identical result as the same answer', async () => {
      const leased = await lease(runId).expect(201);
      const document = finalResult(runId, attemptOf(leased), {
        answer: 'thirty days',
      });

      await settle(runId).send(document).expect(201);
      const replay = await settle(runId).send(document).expect(201);

      expect(replay.body.data.status).toBe('already_settled');
    });

    it('refuses a different answer for work that is already settled', async () => {
      const leased = await lease(runId).expect(201);
      const attempt = attemptOf(leased);

      await settle(runId)
        .send(finalResult(runId, attempt, { a: 1 }))
        .expect(201);
      const conflicting = await settle(runId)
        .send(finalResult(runId, attempt, { a: 2 }))
        .expect(409);

      expect(conflicting.body.error.details.reason).toBe('conflict');

      const stored = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
        select: { output: true },
      });
      expect(stored.output).toEqual({ a: 1 });
    });

    it('refuses an answer from a worker whose attempt has been superseded', async () => {
      const first = await lease(runId).expect(201);
      const stale = attemptOf(first);

      await lease(runId).expect(201); // a newer delivery takes the run

      const response = await settle(runId)
        .send(finalResult(runId, stale, { answer: 'late' }))
        .expect(409);
      expect(response.body.error.details.reason).toBe('stale');

      const stored = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, output: true },
      });
      expect(stored).toEqual({ status: 'RUNNING', output: null });
    });

    it('derives the attempt ordinal itself, so a caller cannot choose one', async () => {
      const first = await lease(runId).expect(201);
      const second = await lease(runId).expect(201);

      expect(attemptOf(first)).toBe(1);
      expect(attemptOf(second)).toBe(2);
    });

    it('does not acknowledge a tool proposal it cannot perform', async () => {
      const leased = await lease(runId).expect(201);

      const response = await settle(runId)
        .send({
          version: '1',
          stepId: `${runId}:${attemptOf(leased)}`,
          runId,
          attempt: attemptOf(leased),
          outcome: 'tool_request',
          invocations: [
            {
              version: '1',
              invocationId: 'inv_1',
              tool: 'knowledge.search@1',
              input: { query: 'refunds' },
            },
          ],
        })
        .expect(409);

      expect(response.body.error.details.reason).toBe('unsupported_outcome');

      const stored = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, output: true, lastError: true },
      });
      expect(stored).toEqual({
        status: 'RUNNING',
        output: null,
        lastError: null,
      });
    });

    it('records a reported failure with the Control Plane’s own diagnostic', async () => {
      const leased = await lease(runId).expect(201);

      await settle(runId)
        .send({
          version: '1',
          stepId: `${runId}:${attemptOf(leased)}`,
          runId,
          attempt: attemptOf(leased),
          outcome: 'failed',
          failure: { version: '1', code: 'timeout' },
        })
        .expect(201);

      const stored = await harness.prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, lastError: true },
      });
      expect(stored).toEqual({
        status: 'RUNNING',
        lastError: 'Agent execution failed',
      });
    });
  });
});
