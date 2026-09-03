import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Queue, type Job } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../src/infrastructure/database';
import {
  ProcessReadiness,
  runShutdownSequence,
} from '../../src/infrastructure/lifecycle';
import {
  OutboxDispatcher,
  OutboxRepository,
} from '../../src/infrastructure/outbox';
import {
  QueueProducer,
  QueueWorkerRunner,
  QUEUE_NAMES,
  type QueueJobHandler,
} from '../../src/infrastructure/queue';
import {
  workerShutdownSteps,
  type WorkerShutdownDeps,
} from '../../src/workers/worker.shutdown';

/**
 * The worker's drain under the two failures that actually compete for the
 * process deadline, both present at once.
 *
 * This is the interleaving the budget exists for, and the test builds it rather
 * than describing it:
 *
 *   - a real BullMQ worker is *actively running a job* that will not finish, and
 *   - the outbox dispatcher is *mid-publish* on a publication that never settles.
 *
 * Redis, the BullMQ worker and the outbox rows are real. The only injected part
 * is the producer, whose `publish` returns a promise that is never resolved —
 * there is no way to make a real Redis hang indefinitely on demand, and a
 * publish that hangs forever is precisely the condition worth bounding.
 *
 * The sequence under test is the production one: `workerShutdownSteps` is
 * imported from the module `worker.ts` itself uses, so this cannot drift into
 * testing a copy.
 */

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6378';

const redis = {
  url: redisUrl,
  keyPrefix: 'worker-shutdown-test:',
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 2_000,
  maxRetriesPerRequest: 2,
};

let namespace = 0;

const queueConfigWith = () => ({
  prefix: `worker-shutdown-${process.pid}-${(namespace += 1)}`,
  workerConcurrency: 1,
  /**
   * Far larger than the deadline below, on purpose. If either drain honoured its
   * own grace instead of the shared budget, this test would run for 30 seconds
   * and the duration assertion would catch it.
   */
  shutdownGraceMs: 30_000,
  job: { attempts: 1, backoffMs: 100 },
  retention: {
    completed: { ageSeconds: 60, count: 10 },
    failed: { ageSeconds: 60, count: 10 },
  },
  outbox: {
    pollIntervalMs: 25,
    batchSize: 10,
    leaseMs: 60_000,
    warnAfterAttempts: 100,
  },
});

const silent = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

/** A BullMQ handler that starts, reports, and never finishes on its own. */
class NeverFinishingHandler implements QueueJobHandler<{ marker: string }> {
  readonly queue = QUEUE_NAMES.agentExecution;
  readonly jobName = 'execute';

  readonly started: string[] = [];
  private release: (() => void) | undefined;

  async handle(job: Job<{ marker: string }>): Promise<void> {
    this.started.push(job.data.marker);
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  finish(): void {
    this.release?.();
  }
}

const until = async (
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('worker shutdown under failure injection (e2e)', () => {
  const SHUTDOWN_DEADLINE_MS = 1_500;

  let prisma: PrismaService;
  let repository: OutboxRepository;
  let queue: ReturnType<typeof queueConfigWith>;
  let readiness: ProcessReadiness;
  let handler: NeverFinishingHandler;
  let runner: QueueWorkerRunner;
  let realProducer: QueueProducer;
  let inspector: Queue;

  /** Records how many publishes were started, and settles none of them. */
  const stuckPublishes: string[] = [];
  const stuckProducer = {
    publish: (
      _queue: string,
      _jobName: string,
      payload: unknown,
    ): Promise<{ jobId: string }> => {
      stuckPublishes.push(JSON.stringify(payload));
      return new Promise<{ jobId: string }>(() => undefined);
    },
    close: () => Promise.resolve(),
  } as unknown as QueueProducer;

  let dispatcher: OutboxDispatcher;
  let reconciler: WorkerShutdownDeps['reconciler'];

  beforeEach(async () => {
    stuckPublishes.length = 0;
    queue = queueConfigWith();

    prisma = new PrismaService({
      url: process.env.DATABASE_URL ?? '',
      connectTimeoutMs: 5_000,
    });
    await prisma.onModuleInit();
    repository = new OutboxRepository(prisma);
    await prisma.outboxEvent.deleteMany({});

    readiness = new ProcessReadiness();
    readiness.markReady();

    handler = new NeverFinishingHandler();
    runner = new QueueWorkerRunner(redis, queue, [handler], silent);

    // Real, so a real job really reaches a real worker.
    realProducer = new QueueProducer(redis, queue, silent);
    realProducer.init();

    inspector = new Queue(QUEUE_NAMES.agentExecution, {
      connection: { url: redisUrl },
      prefix: queue.prefix,
    });
    inspector.on('error', () => undefined);

    dispatcher = new OutboxDispatcher(repository, stuckProducer, queue, silent);

    // The reconciler has nothing to do in this scenario; it is present because
    // the production sequence includes it, and its step must be seen to run in
    // the right position rather than be quietly omitted from the test's copy.
    reconciler = { stop: () => Promise.resolve() };
  }, 60_000);

  afterEach(async () => {
    handler.finish();
    await runner.stop(0);
    await realProducer.close();
    await prisma.outboxEvent.deleteMany({});

    try {
      await inspector.obliterate({ force: true });
    } catch {
      // Nothing to remove.
    }
    await inspector.close();
    await prisma.onModuleDestroy();
  }, 60_000);

  it('finishes inside the global deadline with a stuck publish and an active job', async () => {
    // --- Condition 1: a real job is actively running in a real BullMQ worker.
    runner.start();
    await realProducer.publish(QUEUE_NAMES.agentExecution, 'execute', {
      marker: 'active',
    });
    await until(() => handler.started.includes('active'));

    // --- Condition 2: the dispatcher is mid-publish on something that hangs.
    await repository.append(prisma, {
      type: 'agent-run.queued',
      payload: { agentRunId: 'stuck' },
      dedupeKey: 'stuck',
    });
    dispatcher.start();
    await until(() => stuckPublishes.length > 0);

    const claimedBeforeShutdown = await prisma.outboxEvent.findFirstOrThrow({
      where: { dedupeKey: 'stuck' },
    });
    expect(claimedBeforeShutdown.status).toBe('PROCESSING');

    // --- Shutdown, with a deliberately small deadline.
    const startedAt = Date.now();
    const closed: string[] = [];

    const outcome = await runShutdownSequence(
      workerShutdownSteps({
        dispatcher,
        reconciler,
        readiness,
        runner,
        producer: stuckProducer,
        closeApplication: () => {
          closed.push('application');
          return Promise.resolve();
        },
        drainGraceMs: queue.shutdownGraceMs,
      }),
      {
        logger: silent,
        timeoutMs: SHUTDOWN_DEADLINE_MS,
        // The real one calls process.exit; the assertion is that it never fires.
        onTimeout: () => closed.push('deadline-exceeded'),
      },
    );

    const elapsed = Date.now() - startedAt;

    // It did not hang. The tolerance is for scheduling, not for a second grace
    // period: `shutdownGraceMs` is 30s, so honouring it would blow this by 20x.
    expect(elapsed).toBeLessThan(SHUTDOWN_DEADLINE_MS + 750);
    expect(closed).not.toContain('deadline-exceeded');
    expect(outcome.timedOut).toBe(false);

    // Every step ran, including the cleanup behind the two stuck ones.
    expect(outcome.completed).toEqual([
      'stop-outbox-dispatcher',
      'stop-agent-run-reconciler',
      'mark-not-ready',
      'close-queue-workers',
      'close-queue-producers',
      'close-application',
    ]);
    expect(closed).toContain('application');
    expect(readiness.isDraining).toBe(true);

    // The active job never finished, and nothing pretended it did.
    expect(handler.started).toEqual(['active']);

    /**
     * Deployment is not cancellation, checked on both sides of the process.
     *
     * The outbox row is still `PROCESSING` under its lease — reclaimable — and
     * not `FAILED`. The BullMQ job is neither completed nor failed, so the
     * stalled checker returns it to the queue.
     */
    const outboxRow = await prisma.outboxEvent.findFirstOrThrow({
      where: { dedupeKey: 'stuck' },
    });
    expect(outboxRow.status).toBe('PROCESSING');
    expect(outboxRow.deliveredAt).toBeNull();

    const counts = await inspector.getJobCounts(
      'completed',
      'failed',
      'active',
      'waiting',
    );
    expect(counts.completed).toBe(0);
    expect(counts.failed).toBe(0);
    expect((counts.active ?? 0) + (counts.waiting ?? 0)).toBe(1);
  }, 120_000);

  /**
   * The other half of "no new work is claimed once shutdown begins", measured
   * against the database rather than against a spy: no row's `attempts` moves
   * after the dispatcher has been told to stop.
   */
  it('claims no further outbox work once shutdown has begun', async () => {
    for (const key of ['a', 'b', 'c']) {
      await repository.append(prisma, {
        type: 'agent-run.queued',
        payload: { agentRunId: key },
        dedupeKey: key,
      });
    }

    dispatcher.start();
    await until(() => stuckPublishes.length > 0);

    const claimedDuringRun = await prisma.outboxEvent.count({
      where: { status: 'PROCESSING' },
    });
    expect(claimedDuringRun).toBeGreaterThan(0);

    await runShutdownSequence(
      workerShutdownSteps({
        dispatcher,
        reconciler,
        readiness,
        runner,
        producer: stuckProducer,
        closeApplication: () => Promise.resolve(),
        drainGraceMs: queue.shutdownGraceMs,
      }),
      {
        logger: silent,
        timeoutMs: SHUTDOWN_DEADLINE_MS,
        onTimeout: () => undefined,
      },
    );

    const attemptsAfterShutdown = await prisma.outboxEvent.aggregate({
      _sum: { attempts: true },
    });

    // Long enough for several poll intervals had the loop still been running.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const attemptsLater = await prisma.outboxEvent.aggregate({
      _sum: { attempts: true },
    });
    expect(attemptsLater._sum.attempts).toBe(
      attemptsAfterShutdown._sum.attempts,
    );

    // Only ever one publish attempted: the batch behind the stuck one was
    // abandoned rather than pushed through a closing queue.
    expect(stuckPublishes).toHaveLength(1);

    // And nothing was parked on the way out.
    await expect(
      prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
    ).resolves.toBe(0);
  }, 120_000);
});
