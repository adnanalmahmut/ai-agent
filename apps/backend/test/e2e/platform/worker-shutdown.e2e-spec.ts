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

import { PrismaService } from '../../../src/infrastructure/database';
import {
  ProcessReadiness,
  runShutdownSequence,
} from '../../../src/infrastructure/lifecycle';
import {
  OutboxDispatcher,
  OutboxRepository,
} from '../../../src/infrastructure/outbox';
import {
  QueueProducer,
  QueueWorkerRunner,
  QUEUE_NAMES,
  type QueueJobHandler,
} from '../../../src/infrastructure/queue';
import {
  workerShutdownSteps,
  type WorkerShutdownDeps,
} from '../../../src/workers/worker.shutdown';

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

    realProducer = new QueueProducer(redis, queue, silent);
    realProducer.init();

    inspector = new Queue(QUEUE_NAMES.agentExecution, {
      connection: { url: redisUrl },
      prefix: queue.prefix,
    });
    inspector.on('error', () => undefined);

    dispatcher = new OutboxDispatcher(repository, stuckProducer, queue, silent);

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
      // Forced shutdown may remove the queue before cleanup runs.
    }
    await inspector.close();
    await prisma.onModuleDestroy();
  }, 60_000);

  it('finishes inside the global deadline with a stuck publish and an active job', async () => {
    runner.start();
    await realProducer.publish(QUEUE_NAMES.agentExecution, 'execute', {
      marker: 'active',
    });
    await until(() => handler.started.includes('active'));

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
        onTimeout: () => closed.push('deadline-exceeded'),
      },
    );

    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(SHUTDOWN_DEADLINE_MS + 750);
    expect(closed).not.toContain('deadline-exceeded');
    expect(outcome.timedOut).toBe(false);

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

    expect(handler.started).toEqual(['active']);

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

    await new Promise((resolve) => setTimeout(resolve, 300));

    const attemptsLater = await prisma.outboxEvent.aggregate({
      _sum: { attempts: true },
    });
    expect(attemptsLater._sum.attempts).toBe(
      attemptsAfterShutdown._sum.attempts,
    );

    expect(stuckPublishes).toHaveLength(1);

    await expect(
      prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
    ).resolves.toBe(0);
  }, 120_000);
});
