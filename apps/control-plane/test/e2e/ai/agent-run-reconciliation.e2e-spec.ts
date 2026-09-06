import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Queue, Worker, type Job } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';

import { AgentRunService } from '../../../src/ai/execution/agent-run.service';
import {
  AGENT_RUN_DRIVERS,
  MCP_SESSION_RUNTIME,
  MCP_SESSION_TTL_MS,
  type CreateAgentRun,
} from '../../../src/ai/agents/agent.types';
import { AgentConfigurationError } from '../../../src/ai/agents/agent-configuration.error';
import {
  AgentExecutionHandler,
  type AgentExecutionJob,
} from '../../../src/workers/handlers/agent-execution.handler';
import { AgentRunReconciler } from '../../../src/ai/execution/agent-run-reconciler.service';
import type { AgentRunner } from '../../../src/ai/execution/agent-runner.service';
import { OutboxRepository } from '../../../src/infrastructure/outbox';
import { QueueProducer, QUEUE_NAMES } from '../../../src/infrastructure/queue';
import { PrismaService } from '../../../src/infrastructure/database';
import {
  cleanTestAgentInstallations,
  installTestAgent,
  TEST_AGENT_ID,
  testAgentRegistry,
} from '../../support/agent-run-fixtures';

const fixtureId = `agent-reconcile-e2e-${process.pid}`;
const organizationId = `${fixtureId}-org`;

const redis = {
  url: process.env.REDIS_URL ?? 'redis://localhost:6378',
  keyPrefix: 'agent-reconcile-test:',
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 2_000,
  maxRetriesPerRequest: 2,
};

let namespace = 0;

const queueConfigWith = (attempts = 1) => ({
  prefix: `agent-reconcile-test-${process.pid}-${(namespace += 1)}`,
  workerConcurrency: 1,
  shutdownGraceMs: 5_000,
  job: { attempts, backoffMs: 50 },
  retention: {
    completed: { ageSeconds: 60, count: 20 },
    failed: { ageSeconds: 60, count: 20 },
  },
  outbox: {
    pollIntervalMs: 50,
    batchSize: 10,
    leaseMs: 5_000,
    warnAfterAttempts: 3,
  },
});

const agentsConfigWith = (staleAfterMs = 0) => ({
  reconcile: { intervalMs: 60_000, staleAfterMs, batchSize: 50 },
});

const silent = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const until = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('AgentRun terminal reconciliation (e2e)', () => {
  let prisma: PrismaService;
  let runs: AgentRunService;

  const request = (idempotencyKey: string): CreateAgentRun => ({
    agentId: TEST_AGENT_ID,
    organizationId,
    createdByUserId: null,
    input: { prompt: 'deterministic test input' },
    idempotencyKey,
  });

  const cleanRuns = async () => {
    const existing = await prisma.agentRun.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const runIds = existing.map(({ id }) => id);

    if (runIds.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: { dedupeKey: { in: runIds } },
      });
    }

    await prisma.agentRun.deleteMany({ where: { organizationId } });
  };

  beforeAll(async () => {
    prisma = new PrismaService({
      url: process.env.DATABASE_URL ?? '',
      connectTimeoutMs: 5_000,
    });
    await prisma.onModuleInit();

    await cleanRuns();
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Agent Reconciliation E2E Organization',
        slug: `${fixtureId}-org`,
      },
    });
    await installTestAgent(prisma, organizationId);

    runs = new AgentRunService(
      prisma,
      new OutboxRepository(prisma),
      testAgentRegistry(),
    );
  }, 60_000);

  afterEach(async () => {
    await cleanRuns();
  });

  afterAll(async () => {
    await cleanRuns();
    await cleanTestAgentInstallations(prisma, [organizationId]);
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.onModuleDestroy();
  });

  const rowOf = (runId: string) =>
    prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });

  describe('a job that exhausts its stalled allowance', () => {
    let queue: ReturnType<typeof queueConfigWith>;
    let producer: QueueProducer;
    let inspector: Queue;
    let killed: Worker | undefined;
    let recovering: Worker | undefined;

    beforeAll(() => {
      queue = queueConfigWith();
      producer = new QueueProducer(redis, queue, silent);
      producer.init();
      inspector = new Queue(QUEUE_NAMES.agentExecution, {
        connection: { url: redis.url },
        prefix: queue.prefix,
      });
      inspector.on('error', () => undefined);
    });

    afterAll(async () => {
      await killed?.close(true).catch(() => undefined);
      await recovering?.close(true).catch(() => undefined);
      await producer.close();

      try {
        await inspector.obliterate({ force: true });
      } catch {
        // Cleanup may race with queue removal during forced worker shutdown.
      }
      await inspector.close();
    });

    it('is failed by BullMQ without the handler running, and the reconciler finalizes the run', async () => {
      const run = await runs.create(request('stalled-exhaustion'));
      expect(run.status).toBe('QUEUED');

      const blockedRunner = {
        run: () => new Promise<never>(() => {}),
      } as unknown as AgentRunner;

      const handled: string[] = [];
      const handler = new AgentExecutionHandler(runs, blockedRunner, silent);
      const dispatch = async (job: Job<AgentExecutionJob>) => {
        handled.push(job.id ?? '');
        await handler.handle(job);
      };

      await producer.publish(
        QUEUE_NAMES.agentExecution,
        'execute',
        { runId: run.id },
        { jobId: run.id },
      );

      const workerOptions = {
        connection: { url: redis.url },
        prefix: queue.prefix,
        concurrency: 1,
        lockDuration: 1_000,
        lockRenewTime: 500,
        stalledInterval: 1_000,
        maxStalledCount: 0,
        autorun: false,
      } as const;

      killed = new Worker(QUEUE_NAMES.agentExecution, dispatch, {
        ...workerOptions,
        skipStalledCheck: true,
      });
      killed.on('error', () => undefined);
      void killed.run();

      await until(async () => (await rowOf(run.id)).status === 'RUNNING');
      const claimed = await rowOf(run.id);
      expect(claimed.status).toBe('RUNNING');
      expect(claimed.attemptCount).toBe(1);
      expect(handled).toHaveLength(1);

      await killed.close(true);
      killed = undefined;

      const observed: string[] = [];
      recovering = new Worker(
        QUEUE_NAMES.agentExecution,
        dispatch,
        workerOptions,
      );
      recovering.on('error', () => undefined);
      recovering.on('failed', (_job, error) => observed.push(error.message));
      void recovering.run();

      await until(
        async () => (await inspector.getJobCounts('failed')).failed === 1,
      );

      expect((await inspector.getJobCounts('failed')).failed).toBe(1);
      expect(observed).toEqual(['job stalled more than allowable limit']);

      expect(handled).toHaveLength(1);
      const stranded = await rowOf(run.id);
      expect(stranded.status).toBe('RUNNING');
      expect(stranded.completedAt).toBeNull();

      const reconciler = new AgentRunReconciler(
        runs,
        producer,
        agentsConfigWith(),
        silent,
      );

      await expect(reconciler.reconcileOnce()).resolves.toMatchObject({
        failed: 1,
        reconciled: 1,
        missing: 0,
      });

      const settled = await rowOf(run.id);
      expect(settled.status).toBe('FAILED');
      expect(settled.completedAt).not.toBeNull();
      expect(settled.lastError).toBe('Agent execution ended without a result');
      expect(settled.lastError).not.toContain('stalled');

      await expect(reconciler.reconcileOnce()).resolves.toMatchObject({
        reconciled: 0,
      });
      expect((await rowOf(run.id)).completedAt).toEqual(settled.completedAt);
    }, 120_000);
  });

  describe('idempotence and terminal safety', () => {
    let queue: ReturnType<typeof queueConfigWith>;
    let producer: QueueProducer;
    let inspector: Queue;
    let worker: Worker | undefined;
    let reconciler: AgentRunReconciler;

    beforeAll(() => {
      queue = queueConfigWith();
      producer = new QueueProducer(redis, queue, silent);
      producer.init();
      inspector = new Queue(QUEUE_NAMES.agentExecution, {
        connection: { url: redis.url },
        prefix: queue.prefix,
      });
      inspector.on('error', () => undefined);
      reconciler = new AgentRunReconciler(
        runs,
        producer,
        agentsConfigWith(),
        silent,
      );
    });

    afterAll(async () => {
      await worker?.close(true).catch(() => undefined);
      await producer.close();

      try {
        await inspector.obliterate({ force: true });
      } catch {
        // Cleanup may race with queue removal during forced worker shutdown.
      }
      await inspector.close();
    });

    const failJobFor = async (runId: string): Promise<void> => {
      await producer.publish(
        QUEUE_NAMES.agentExecution,
        'execute',
        { runId },
        { jobId: runId },
      );

      worker = new Worker(
        QUEUE_NAMES.agentExecution,
        () => Promise.reject(new Error('Agent execution failed')),
        {
          connection: { url: redis.url },
          prefix: queue.prefix,
          concurrency: 1,
          autorun: false,
        },
      );
      worker.on('error', () => undefined);
      void worker.run();

      await until(
        async () => (await inspector.getJobState(runId)) === 'failed',
      );
      expect(await inspector.getJobState(runId)).toBe('failed');

      await worker.close(true);
      worker = undefined;
    };

    it('finalizes a RUNNING run and sets completedAt', async () => {
      const run = await runs.create(request('running-to-failed'));
      await runs.claimExecutionAttempt(run.id, 1);
      expect((await rowOf(run.id)).status).toBe('RUNNING');

      await failJobFor(run.id);

      await expect(reconciler.reconcileOnce()).resolves.toMatchObject({
        reconciled: 1,
      });

      const settled = await rowOf(run.id);
      expect(settled.status).toBe('FAILED');
      expect(settled.completedAt).not.toBeNull();
      expect(settled.lastError).toBe('Agent execution ended without a result');
      expect(settled.attemptCount).toBe(1);
    }, 60_000);

    it('finalizes a run that never left QUEUED', async () => {
      const run = await runs.create(request('queued-to-failed'));
      expect((await rowOf(run.id)).status).toBe('QUEUED');

      await failJobFor(run.id);

      await expect(reconciler.reconcileOnce()).resolves.toMatchObject({
        reconciled: 1,
      });

      const settled = await rowOf(run.id);
      expect(settled.status).toBe('FAILED');
      expect(settled.completedAt).not.toBeNull();
    }, 60_000);

    it('leaves a run the handler already failed exactly as it found it', async () => {
      const run = await runs.create(request('handler-failed-first'));
      await runs.claimExecutionAttempt(run.id, 1);
      await runs.recordExecutionFailure(
        run.id,
        1,
        'Agent execution failed',
        true,
      );

      const before = await rowOf(run.id);
      expect(before.status).toBe('FAILED');

      await failJobFor(run.id);

      await expect(reconciler.reconcileOnce()).resolves.toMatchObject({
        examined: 0,
        failed: 0,
        reconciled: 0,
      });

      await expect(runs.reconcileTerminalFailure(run.id)).resolves.toBe(false);

      const after = await rowOf(run.id);
      expect(after.status).toBe('FAILED');
      expect(after.lastError).toBe('Agent execution failed');
      expect(after.completedAt).toEqual(before.completedAt);
    }, 60_000);

    it('never converts a SUCCEEDED run into a failed one', async () => {
      const run = await runs.create(request('succeeded-stays'));
      await runs.claimExecutionAttempt(run.id, 1);
      await runs.markExecutionSucceeded(run.id, 1, { answer: 'done' });

      const before = await rowOf(run.id);
      expect(before.status).toBe('SUCCEEDED');

      await failJobFor(run.id);

      await reconciler.reconcileOnce();

      await expect(runs.reconcileTerminalFailure(run.id)).resolves.toBe(false);

      const after = await rowOf(run.id);
      expect(after.status).toBe('SUCCEEDED');
      expect(after.output).toEqual({ answer: 'done' });
      expect(after.lastError).toBeNull();
      expect(after.completedAt).toEqual(before.completedAt);
    }, 60_000);

    it('is unchanged by repeated passes and by a freshly constructed reconciler', async () => {
      const run = await runs.create(request('repeat-observation'));
      await runs.claimExecutionAttempt(run.id, 1);
      await failJobFor(run.id);

      await reconciler.reconcileOnce();
      const settled = await rowOf(run.id);
      expect(settled.status).toBe('FAILED');

      const restarted = new AgentRunReconciler(
        runs,
        producer,
        agentsConfigWith(),
        silent,
      );

      await expect(restarted.reconcileOnce()).resolves.toMatchObject({
        examined: 0,
        reconciled: 0,
      });
      expect(await rowOf(run.id)).toEqual(settled);
    }, 60_000);

    it('leaves a run alone while its job is still in the transport', async () => {
      const run = await runs.create(request('still-pending'));
      await runs.claimExecutionAttempt(run.id, 1);

      await producer.publish(
        QUEUE_NAMES.agentExecution,
        'execute',
        { runId: run.id },
        { jobId: run.id },
      );
      expect(await inspector.getJobState(run.id)).toBe('waiting');

      await expect(reconciler.reconcileOnce()).resolves.toMatchObject({
        pending: 1,
        failed: 0,
        reconciled: 0,
      });

      expect((await rowOf(run.id)).status).toBe('RUNNING');
    }, 60_000);

    it('leaves a run alone when the transport holds no record of its job', async () => {
      const run = await runs.create(request('no-transport-record'));
      await runs.claimExecutionAttempt(run.id, 1);

      expect(await inspector.getJobState(run.id)).toBe('unknown');

      await expect(reconciler.reconcileOnce()).resolves.toMatchObject({
        missing: 1,
        reconciled: 0,
      });

      expect((await rowOf(run.id)).status).toBe('RUNNING');
    }, 60_000);

    it('treats an unknown run as a no-op rather than a failure', async () => {
      await expect(
        runs.reconcileTerminalFailure('11111111-2222-3333-4444-555555555555'),
      ).resolves.toBe(false);
    }, 30_000);
  });

  describe('candidate paging', () => {
    it('pages through runs that share an updatedAt without skipping or repeating', async () => {
      const created = [];
      for (let index = 0; index < 5; index += 1) {
        created.push(await runs.create(request(`paging-${index}`)));
      }

      const sharedInstant = new Date('2026-08-22T00:00:00.000Z');
      await prisma.$executeRaw`
        UPDATE "agent_run" SET "updatedAt" = ${sharedInstant}
        WHERE "organizationId" = ${organizationId}`;

      const staleBefore = new Date('2026-08-22T00:01:00.000Z');
      const seen: string[] = [];
      let cursor: { updatedAt: Date; id: string } | undefined;

      for (let pass = 0; pass < 4; pass += 1) {
        const page = await runs.findStaleNonTerminal(staleBefore, 2, cursor);
        if (page.length === 0) break;

        seen.push(...page.map((row) => row.id));
        const last = page[page.length - 1];
        cursor = { updatedAt: last.updatedAt, id: last.id };
      }

      expect(seen).toHaveLength(created.length);
      expect(new Set(seen).size).toBe(created.length);
      expect([...seen].sort()).toEqual(created.map((run) => run.id).sort());
    }, 60_000);

    it('excludes a run that is not yet stale', async () => {
      const fresh = await runs.create(request('paging-fresh'));

      const candidates = await runs.findStaleNonTerminal(
        new Date(Date.now() - 60_000),
        50,
      );

      expect(candidates.map((row) => row.id)).not.toContain(fresh.id);
    }, 60_000);
  });

  describe('deterministic execution failures', () => {
    const RETRY_BUDGET = 3;

    let queue: ReturnType<typeof queueConfigWith>;
    let producer: QueueProducer;
    let inspector: Queue;
    let worker: Worker | undefined;

    beforeAll(() => {
      queue = queueConfigWith(RETRY_BUDGET);
      producer = new QueueProducer(redis, queue, silent);
      producer.init();
      inspector = new Queue(QUEUE_NAMES.agentExecution, {
        connection: { url: redis.url },
        prefix: queue.prefix,
      });
      inspector.on('error', () => undefined);
    });

    afterAll(async () => {
      await worker?.close(true).catch(() => undefined);
      await producer.close();

      try {
        await inspector.obliterate({ force: true });
      } catch {
        // Cleanup may race with queue removal during forced worker shutdown.
      }
      await inspector.close();
    });

    const drain = async (
      runId: string,
      runner: AgentRunner,
    ): Promise<string[]> => {
      const invocations: string[] = [];
      const handler = new AgentExecutionHandler(runs, runner, silent);

      await producer.publish(
        QUEUE_NAMES.agentExecution,
        'execute',
        { runId },
        { jobId: runId },
      );

      worker = new Worker(
        QUEUE_NAMES.agentExecution,
        async (delivered: Job<AgentExecutionJob>) => {
          invocations.push(delivered.id ?? '');
          await handler.handle(delivered);
        },
        {
          connection: { url: redis.url },
          prefix: queue.prefix,
          concurrency: 1,
          autorun: false,
        },
      );
      worker.on('error', () => undefined);
      void worker.run();

      await until(
        async () => (await inspector.getJobState(runId)) === 'failed',
      );
      expect(await inspector.getJobState(runId)).toBe('failed');

      await worker.close(true);
      worker = undefined;

      return invocations;
    };

    const configurationRunner = {
      run: () =>
        Promise.reject(
          new AgentConfigurationError(
            'Agent definition "test-only-agent@1" is not registered',
          ),
        ),
    } as unknown as AgentRunner;

    const job = (runId: string): Job<AgentExecutionJob> =>
      ({
        id: runId,
        data: { runId },
        attemptsMade: 0,
        attemptsStarted: 1,
        opts: { attempts: 3 },
      }) as Job<AgentExecutionJob>;

    it('finalizes the run on the first attempt instead of retrying', async () => {
      const run = await runs.create(request('deterministic-first-attempt'));
      const handler = new AgentExecutionHandler(
        runs,
        configurationRunner,
        silent,
      );

      const rejection = handler.handle(job(run.id));
      await expect(rejection).rejects.toThrow('Agent execution failed');
      await rejection.catch((error: Error) => {
        expect(error.name).toBe('UnrecoverableError');
        expect(error.message).toBe('Agent execution failed');
      });

      const settled = await rowOf(run.id);
      expect(settled.status).toBe('FAILED');
      expect(settled.completedAt).not.toBeNull();
      expect(settled.lastError).toBe('Agent execution failed');
      expect(settled.lastError).not.toContain('test-only-agent');
    }, 60_000);

    it('does not send UnrecoverableError from a delivery that lost its claim', async () => {
      const run = await runs.create(request('deterministic-stale-owner'));

      const supersededRunner = {
        run: async () => {
          await runs.claimExecutionAttempt(run.id, 2);
          throw new AgentConfigurationError(
            'Agent definition "test-only-agent@1" is not registered',
          );
        },
      } as unknown as AgentRunner;

      const handler = new AgentExecutionHandler(runs, supersededRunner, silent);

      const rejection = handler.handle(job(run.id));
      await expect(rejection).rejects.toThrow('Agent execution failed');
      await rejection.catch((error: Error) => {
        expect(error.name).toBe('Error');
        expect(error.message).toBe('Agent execution failed');
      });

      const untouched = await rowOf(run.id);
      expect(untouched.status).toBe('RUNNING');
      expect(untouched.attemptCount).toBe(2);
      expect(untouched.completedAt).toBeNull();
      expect(untouched.lastError).toBeNull();
    }, 60_000);

    it('makes BullMQ stop after one attempt instead of spending three', async () => {
      const run = await runs.create(request('deterministic-no-retry'));

      const invocations = await drain(run.id, configurationRunner);

      expect(invocations).toHaveLength(1);

      const settled = await rowOf(run.id);
      expect(settled.status).toBe('FAILED');
      expect(settled.completedAt).not.toBeNull();
      expect(settled.lastError).toBe('Agent execution failed');
    }, 60_000);

    it('still spends the whole budget on an ordinary runtime failure', async () => {
      const run = await runs.create(request('transient-uses-budget'));

      const transientRunner = {
        run: () => Promise.reject(new Error('provider timed out')),
      } as unknown as AgentRunner;

      const invocations = await drain(run.id, transientRunner);

      expect(invocations).toHaveLength(RETRY_BUDGET);

      const settled = await rowOf(run.id);
      expect(settled.status).toBe('FAILED');
      expect(settled.lastError).toBe('Agent execution failed');
      const failedJob = await inspector.getJob(run.id);
      expect(failedJob?.failedReason).toBe('Agent execution failed');
    }, 60_000);
  });
  // An MCP session is an AgentRun with no queue job behind it, so nothing in
  // the transport can ever finish it. The reconciler is the only thing that
  // closes one the client walked away from — and until it does, the session
  // still counts against the organization's in-flight ceiling.
  describe('an abandoned MCP session', () => {
    const openSession = async (idempotencyKey: string, maxInFlight?: number) =>
      runs.create({
        ...request(idempotencyKey),
        driver: AGENT_RUN_DRIVERS.mcpClient,
        ...(maxInFlight === undefined ? {} : { maxInFlight }),
      });

    // Both timestamps are moved: createdAt is what decides expiry, updatedAt is
    // what the staleness scan orders and filters by. Waiting out a one-hour TTL
    // is not a test.
    const age = (runId: string, byMs: number) => {
      const at = new Date(Date.now() - byMs);
      return prisma.agentRun.update({
        where: { id: runId },
        data: { createdAt: at, updatedAt: at },
      });
    };

    // The suite shares one database, so a pass may also examine rows this spec
    // did not create. Foreign worker runs are reported as still in transit,
    // which makes the reconciler leave them exactly as they are; asking about a
    // session at all would be the defect, so the ids are recorded and asserted
    // against instead.
    const passOver = async (): Promise<string[]> => {
      const asked: string[] = [];

      await new AgentRunReconciler(
        runs,
        {
          jobTransportState: (_queue: unknown, runId: string) => {
            asked.push(runId);
            return Promise.resolve('pending');
          },
        } as unknown as QueueProducer,
        agentsConfigWith(0),
        silent,
      ).reconcileOnce();

      return asked;
    };

    it('is opened RUNNING with no queue job and no outbox event', async () => {
      const session = await openSession('mcp-abandoned-shape');

      const row = await rowOf(session.id);
      expect(row.status).toBe('RUNNING');
      expect(row.runtime).toBe(MCP_SESSION_RUNTIME);
      expect(row.attemptCount).toBe(1);

      const events = await prisma.outboxEvent.findMany({
        where: { dedupeKey: session.id },
      });
      expect(events).toEqual([]);
    }, 60_000);

    it('is closed by expiry, while a session still inside its TTL is left open', async () => {
      const live = await openSession('mcp-abandoned-live');
      const expired = await openSession('mcp-abandoned-expired');

      // Aged into the same scan, on opposite sides of the TTL. One pass
      // deciding both is what proves the live one was examined and spared,
      // rather than simply never reached.
      await age(live.id, MCP_SESSION_TTL_MS - 60_000);
      await age(expired.id, MCP_SESSION_TTL_MS);

      const asked = await passOver();

      expect(asked).not.toContain(live.id);
      expect(asked).not.toContain(expired.id);

      expect((await rowOf(live.id)).status).toBe('RUNNING');

      const closed = await rowOf(expired.id);
      expect(closed.status).toBe('SUCCEEDED');
      expect(closed.completedAt).not.toBeNull();
      expect(closed.output).toEqual({ closedBy: 'expiry' });
    }, 60_000);

    it('holds the organization in-flight ceiling until it is swept', async () => {
      const session = await openSession('mcp-abandoned-holds-capacity', 1);
      await age(session.id, MCP_SESSION_TTL_MS);

      // Expired on the clock, but still RUNNING in PostgreSQL — and capacity is
      // counted from the row, not from the clock.
      await expect(
        openSession('mcp-abandoned-blocked-by-capacity', 1),
      ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

      await passOver();
      expect((await rowOf(session.id)).status).toBe('SUCCEEDED');

      const next = await openSession('mcp-abandoned-after-sweep', 1);
      expect(next.id).not.toBe(session.id);
    }, 60_000);

    it('leaves a session the client already closed exactly as it found it', async () => {
      const session = await openSession('mcp-abandoned-client-closed');
      await age(session.id, MCP_SESSION_TTL_MS);

      const closed = await runs.closeMcpSession({
        id: session.id,
        organizationId,
        closedBy: 'client',
      });
      expect(closed).toBe(true);

      await passOver();

      expect((await rowOf(session.id)).output).toEqual({ closedBy: 'client' });
    }, 60_000);
  });
});
