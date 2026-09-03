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

import {
  AgentRunService,
  type CreateAgentRun,
} from '../../src/features/agent-management';
import { AgentConfigurationError } from '../../src/ai/agents/agent-configuration.error';
import {
  AgentExecutionHandler,
  type AgentExecutionJob,
} from '../../src/workers/handlers/agent-execution.handler';
import { AgentRunReconciler } from '../../src/ai/execution/agent-run-reconciler.service';
import type { AgentRunner } from '../../src/ai/execution/agent-runner.service';
import { OutboxRepository } from '../../src/infrastructure/outbox';
import { QueueProducer, QUEUE_NAMES } from '../../src/infrastructure/queue';
import { PrismaService } from '../../src/infrastructure/database';
import {
  cleanTestAgentInstallations,
  installTestAgent,
  TEST_AGENT_ID,
  testAgentRegistry,
} from '../support/agent-run-fixtures';

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

/** A fresh BullMQ prefix per test, so `obliterate` can only reach its own keys. */
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

/**
 * Terminal transport reconciliation, against a real PostgreSQL and a real
 * BullMQ.
 *
 * Mocks would make most of this meaningless. The defect being closed is a
 * property of BullMQ's own Lua and its worker loop — a job that exceeds its
 * stalled allowance is failed *without the processor being invoked* — so the
 * only way to prove the application recovers from it is to make it actually
 * happen.
 */
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

  /**
   * The gap itself, reproduced end to end.
   *
   * The sequence is BullMQ's, not ours: a worker claims the job and dies
   * holding it; its lock expires; the stalled check finds an active job with no
   * lock, exceeds `maxStalledCount`, writes a deferred-failure marker and
   * returns the job to `wait`; the next fetch turns that marker into a
   * synthetic `UnrecoverableError` and fails the job **on the branch that skips
   * the processor entirely**.
   *
   * The assertions in the middle are the point. The handler is never called a
   * second time, and the run is therefore still `RUNNING` with no completion —
   * that is the durable state this whole change exists to repair. Only then is
   * the reconciler allowed to run.
   */
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
        // Nothing was ever published.
      }
      await inspector.close();
    });

    it('is failed by BullMQ without the handler running, and the reconciler finalizes the run', async () => {
      const run = await runs.create(request('stalled-exhaustion'));
      expect(run.status).toBe('QUEUED');

      /**
       * Never settles. This worker is standing in for one that is killed mid
       * job — the job stays active, the lock stops being renewed, and nothing
       * ever writes an outcome.
       */
      const blockedRunner = {
        run: () => new Promise<never>(() => {}),
      } as unknown as AgentRunner;

      const handled: string[] = [];
      const handler = new AgentExecutionHandler(runs, blockedRunner, silent);
      const dispatch = async (job: Job<AgentExecutionJob>) => {
        handled.push(job.id ?? '');
        await handler.handle(job);
      };

      // The job id is the run id, exactly as the outbox dispatcher publishes it.
      await producer.publish(
        QUEUE_NAMES.agentExecution,
        'execute',
        { runId: run.id },
        { jobId: run.id },
      );

      /**
       * A short lock and a short stalled interval, because the defaults are 30
       * seconds each. `maxStalledCount: 0` means the first recovery already
       * exceeds the allowance, which is the state under test.
       */
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
        // No stalled check on this one: it is the worker that dies.
        skipStalledCheck: true,
      });
      killed.on('error', () => undefined);
      void killed.run();

      // It claimed the attempt durably before blocking.
      await until(async () => (await rowOf(run.id)).status === 'RUNNING');
      const claimed = await rowOf(run.id);
      expect(claimed.status).toBe('RUNNING');
      expect(claimed.attemptCount).toBe(1);
      expect(handled).toHaveLength(1);

      // The worker dies still holding the job. `close(true)` abandons the
      // in-flight handler rather than waiting for a promise that never settles.
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

      // BullMQ moves it to the failed set on its own.
      await until(
        async () => (await inspector.getJobCounts('failed')).failed === 1,
      );

      expect((await inspector.getJobCounts('failed')).failed).toBe(1);
      expect(observed).toEqual(['job stalled more than allowable limit']);

      /**
       * The two assertions that define the defect. The processor was not called
       * again — `handled` is still the single original delivery — so no
       * application code had any opportunity to record an outcome, and the run
       * is stranded mid-flight.
       */
      expect(handled).toHaveLength(1);
      const stranded = await rowOf(run.id);
      expect(stranded.status).toBe('RUNNING');
      expect(stranded.completedAt).toBeNull();

      // --- Now the repair. ---
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
      // An application constant. BullMQ's own wording for this failure is "job
      // stalled more than allowable limit", and it must not be what the
      // business column says.
      expect(settled.lastError).toBe('Agent execution ended without a result');
      expect(settled.lastError).not.toContain('stalled');

      // Running it again changes nothing.
      await expect(reconciler.reconcileOnce()).resolves.toMatchObject({
        reconciled: 0,
      });
      expect((await rowOf(run.id)).completedAt).toEqual(settled.completedAt);
    }, 120_000);
  });

  /**
   * The state machine, driven directly.
   *
   * The scenario above proves the mechanism fires; these prove it is safe to
   * fire repeatedly, late, out of order, and against runs somebody else has
   * already finished. Each uses a real failed BullMQ job so the transport
   * lookup is genuine.
   */
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
        // Nothing was ever published.
      }
      await inspector.close();
    });

    /** Publishes a job under the run's id and drives it into the failed set. */
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
      // The claim ordinal is left exactly as the last delivery set it. The
      // reconciler is not an attempt and must not forge one.
      expect(settled.attemptCount).toBe(1);
    }, 60_000);

    /**
     * `QUEUED` is reachable: a worker can be killed between BullMQ's
     * move-to-active and the handler's first durable write, so the run never
     * left `QUEUED` even though its job has now been abandoned.
     */
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

    /**
     * The convergence requirement. The handler already recorded the failure on
     * its final attempt, and the queue observation arrives afterwards; both
     * describe the same outcome, so the second must change nothing at all —
     * including `completedAt` and `lastError`, which an operator reads as when
     * and why the work ended.
     *
     * Two layers are asserted because they fail separately. The sweep never
     * even considers the run, since a terminal row is not a candidate; and the
     * write it would have issued is itself a no-op, which is what keeps the
     * guarantee if a candidate goes terminal between the query and the write.
     */
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

      // And directly, bypassing the candidate query entirely.
      await expect(runs.reconcileTerminalFailure(run.id)).resolves.toBe(false);

      const after = await rowOf(run.id);
      expect(after.status).toBe('FAILED');
      expect(after.lastError).toBe('Agent execution failed');
      expect(after.completedAt).toEqual(before.completedAt);
    }, 60_000);

    /**
     * The dangerous direction. A worker can finish successfully while its job
     * is already in the failed set — it stalled, the transport gave up, and the
     * model call it started returned anyway. A delayed observation must never
     * turn that into a failure.
     */
    it('never converts a SUCCEEDED run into a failed one', async () => {
      const run = await runs.create(request('succeeded-stays'));
      await runs.claimExecutionAttempt(run.id, 1);
      await runs.markExecutionSucceeded(run.id, 1, { answer: 'done' });

      const before = await rowOf(run.id);
      expect(before.status).toBe('SUCCEEDED');

      await failJobFor(run.id);

      await reconciler.reconcileOnce();

      /**
       * Both layers, because they fail separately and this is the direction
       * that destroys a real result. The candidate query excludes a terminal
       * run; the write refuses one even when handed it directly, which is the
       * guard that matters if a candidate succeeds between the query and the
       * write.
       */
      await expect(runs.reconcileTerminalFailure(run.id)).resolves.toBe(false);

      const after = await rowOf(run.id);
      expect(after.status).toBe('SUCCEEDED');
      expect(after.output).toEqual({ answer: 'done' });
      expect(after.lastError).toBeNull();
      expect(after.completedAt).toEqual(before.completedAt);
    }, 60_000);

    /**
     * Restart and duplicate observation are the same test. The reconciler keeps
     * nothing between passes — a second pass, or a pass in a process that has
     * just started, rebuilds its candidate list from PostgreSQL and reaches the
     * same conclusion.
     */
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

    /**
     * A run whose job is still waiting, active or delayed is not the
     * reconciler's business, however long it has been quiet. Failing on silence
     * would turn a queue backlog into destroyed work.
     */
    it('leaves a run alone while its job is still in the transport', async () => {
      const run = await runs.create(request('still-pending'));
      await runs.claimExecutionAttempt(run.id, 1);

      await producer.publish(
        QUEUE_NAMES.agentExecution,
        'execute',
        { runId: run.id },
        { jobId: run.id },
      );
      // Nothing consumes it, so it sits in `wait`.
      expect(await inspector.getJobState(run.id)).toBe('waiting');

      await expect(reconciler.reconcileOnce()).resolves.toMatchObject({
        pending: 1,
        failed: 0,
        reconciled: 0,
      });

      expect((await rowOf(run.id)).status).toBe('RUNNING');
    }, 60_000);

    /**
     * Absence is not evidence. Retention removes a failed job after a week, and
     * the outbox has not published one at all for a run accepted a moment ago —
     * neither says the work will not happen, so neither may end a run.
     */
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

    /**
     * A run that no longer exists is not an error. The transport outlives the
     * rows it referred to, and a reconciler that threw here would abandon every
     * remaining candidate in the batch.
     */
    it('treats an unknown run as a no-op rather than a failure', async () => {
      await expect(
        runs.reconcileTerminalFailure('11111111-2222-3333-4444-555555555555'),
      ).resolves.toBe(false);
    }, 30_000);
  });

  /**
   * The keyset predicate, against the real PostgreSQL.
   *
   * The unit tests assert the cursor the reconciler *passes*; only this asserts
   * that the database honours it. The tie-break is the part worth proving:
   * `updatedAt` is a millisecond timestamp and rows written together share one,
   * so a cursor compared on the timestamp alone would skip every row in the
   * last one's millisecond — silently, and only under load.
   */
  describe('candidate paging', () => {
    it('pages through runs that share an updatedAt without skipping or repeating', async () => {
      const created = [];
      for (let index = 0; index < 5; index += 1) {
        created.push(await runs.create(request(`paging-${index}`)));
      }

      // Forced equal, which is what makes this a test of the tie-break rather
      // than of the timestamp comparison.
      const sharedInstant = new Date('2026-08-22T00:00:00.000Z');
      await prisma.$executeRaw`
        UPDATE "agent_run" SET "updatedAt" = ${sharedInstant}
        WHERE "organizationId" = ${organizationId}`;

      const staleBefore = new Date('2026-08-22T00:01:00.000Z');
      const seen: string[] = [];
      let cursor: { updatedAt: Date; id: string } | undefined;

      // Two at a time, so the walk crosses page boundaries inside one instant.
      for (let pass = 0; pass < 4; pass += 1) {
        const page = await runs.findStaleNonTerminal(staleBefore, 2, cursor);
        if (page.length === 0) break;

        seen.push(...page.map((row) => row.id));
        const last = page[page.length - 1];
        cursor = { updatedAt: last.updatedAt, id: last.id };
      }

      // Every row exactly once: no skip, no repeat.
      expect(seen).toHaveLength(created.length);
      expect(new Set(seen).size).toBe(created.length);
      expect([...seen].sort()).toEqual(created.map((run) => run.id).sort());
    }, 60_000);

    it('excludes a run that is not yet stale', async () => {
      const fresh = await runs.create(request('paging-fresh'));

      // The cutoff is in the past, so a run written just now is behind it.
      const candidates = await runs.findStaleNonTerminal(
        new Date(Date.now() - 60_000),
        50,
      );

      expect(candidates.map((row) => row.id)).not.toContain(fresh.id);
    }, 60_000);
  });

  /**
   * Deterministic configuration failures, against the real database.
   *
   * The unit spec proves the handler's branching; this proves the durable
   * consequence — the run is finished on the first attempt rather than left
   * `RUNNING` while BullMQ burns a retry budget on something that cannot
   * succeed.
   */
  describe('deterministic execution failures', () => {
    /**
     * Three attempts configured, so "it stopped after one" means something.
     * With the single-attempt default used elsewhere in this file, a test
     * asserting one invocation would pass whatever the handler threw.
     */
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
        // Nothing was ever published.
      }
      await inspector.close();
    });

    /** Runs one job to terminal state through the real worker loop. */
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

      // Attempt 1 of 3, and still terminal.
      const rejection = handler.handle(job(run.id));
      await expect(rejection).rejects.toThrow('Agent execution failed');
      await rejection.catch((error: Error) => {
        expect(error.name).toBe('UnrecoverableError');
        // The registry's message names the definition; none of it survives.
        expect(error.message).toBe('Agent execution failed');
      });

      const settled = await rowOf(run.id);
      expect(settled.status).toBe('FAILED');
      expect(settled.completedAt).not.toBeNull();
      expect(settled.lastError).toBe('Agent execution failed');
      expect(settled.lastError).not.toContain('test-only-agent');
    }, 60_000);

    /**
     * A stale delivery must not terminally fail a job whose newer delivery is
     * still working.
     *
     * The claim has to be lost *while this delivery is executing*, which is the
     * only way to reach the branch: a delivery whose claim is already stale is
     * refused at `claimExecutionAttempt` and never reaches the runner at all.
     * So the runner itself bumps the ordinal — standing in for a newer delivery
     * arriving mid-flight — and only then fails deterministically. The
     * finalizing write now matches nothing, and the rejection must be ordinary
     * so BullMQ's own lock arbitrates instead of this worker terminally failing
     * a job somebody else owns.
     */
    it('does not send UnrecoverableError from a delivery that lost its claim', async () => {
      const run = await runs.create(request('deterministic-stale-owner'));

      const supersededRunner = {
        run: async () => {
          // A newer delivery takes ownership while this one is executing.
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
        // Ordinary, not unrecoverable: the deterministic classification is
        // real, but this delivery no longer has the standing to act on it.
        expect(error.name).toBe('Error');
        expect(error.message).toBe('Agent execution failed');
      });

      // The newer owner's state is intact — no FAILED, no completedAt, and the
      // ordinal it claimed is untouched.
      const untouched = await rowOf(run.id);
      expect(untouched.status).toBe('RUNNING');
      expect(untouched.attemptCount).toBe(2);
      expect(untouched.completedAt).toBeNull();
      expect(untouched.lastError).toBeNull();
    }, 60_000);

    /**
     * The transport half of the claim, which the unit tests cannot make.
     *
     * Everything else asserts the object the handler throws. This asserts what
     * BullMQ then does with it: the processor runs once against a job
     * configured for three attempts, and the job is terminal immediately. That
     * is the whole point of classifying these failures — without it the run
     * would sit `RUNNING` through two more attempts and their backoff.
     */
    it('makes BullMQ stop after one attempt instead of spending three', async () => {
      const run = await runs.create(request('deterministic-no-retry'));

      const invocations = await drain(run.id, configurationRunner);

      // Three were configured; one was spent.
      expect(invocations).toHaveLength(1);

      const settled = await rowOf(run.id);
      expect(settled.status).toBe('FAILED');
      expect(settled.completedAt).not.toBeNull();
      expect(settled.lastError).toBe('Agent execution failed');
    }, 60_000);

    /**
     * The contrast that gives the previous test its meaning. Same queue, same
     * budget, same handler — only the error class differs, and this one is
     * delivered all three times before the run is finalized. Without this, "one
     * invocation" could just as well be a queue that never retries anything.
     */
    it('still spends the whole budget on an ordinary runtime failure', async () => {
      const run = await runs.create(request('transient-uses-budget'));

      const transientRunner = {
        run: () => Promise.reject(new Error('provider timed out')),
      } as unknown as AgentRunner;

      const invocations = await drain(run.id, transientRunner);

      expect(invocations).toHaveLength(RETRY_BUDGET);

      const settled = await rowOf(run.id);
      expect(settled.status).toBe('FAILED');
      // The provider's own words reached neither the column nor the queue.
      expect(settled.lastError).toBe('Agent execution failed');
      const failedJob = await inspector.getJob(run.id);
      expect(failedJob?.failedReason).toBe('Agent execution failed');
    }, 60_000);
  });
});
