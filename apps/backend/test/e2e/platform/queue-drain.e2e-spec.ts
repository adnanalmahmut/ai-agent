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

import {
  QueueProducer,
  QueuePublishError,
  QueueWorkerRunner,
  QUEUE_NAMES,
  type QueueJobHandler,
} from '../../../src/infrastructure/queue';

const redis = {
  url: process.env.REDIS_URL ?? 'redis://localhost:6378',
  keyPrefix: 'queue-drain-test:',
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 2_000,
  maxRetriesPerRequest: 2,
};

let namespace = 0;

const queueConfigWith = (overrides: { shutdownGraceMs: number }) => ({
  prefix: `queue-drain-test-${process.pid}-${(namespace += 1)}`,
  workerConcurrency: 1,
  shutdownGraceMs: overrides.shutdownGraceMs,
  job: { attempts: 1, backoffMs: 100 },
  retention: {
    completed: { ageSeconds: 60, count: 10 },
    failed: { ageSeconds: 60, count: 10 },
  },
  outbox: {
    pollIntervalMs: 50,
    batchSize: 10,
    leaseMs: 5_000,
    warnAfterAttempts: 3,
  },
});

const silent = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

class GatedHandler implements QueueJobHandler<{ marker: string }> {
  readonly queue = QUEUE_NAMES.agentExecution;
  readonly jobName = 'execute';

  readonly started: string[] = [];
  readonly finished: string[] = [];

  private release: (() => void) | undefined;
  private gate = Promise.resolve();

  close(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  open(): void {
    this.release?.();
  }

  async handle(job: Job<{ marker: string }>): Promise<void> {
    this.started.push(job.data.marker);
    await this.gate;
    this.finished.push(job.data.marker);
  }
}

const until = async (
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('queue worker drain (e2e)', () => {
  let queue: ReturnType<typeof queueConfigWith>;
  let producer: QueueProducer;
  let runner: QueueWorkerRunner;
  let handler: GatedHandler;
  let inspector: Queue;

  const boot = (shutdownGraceMs: number) => {
    queue = queueConfigWith({ shutdownGraceMs });
    handler = new GatedHandler();
    producer = new QueueProducer(redis, queue, silent);
    runner = new QueueWorkerRunner(redis, queue, [handler], silent);
    inspector = new Queue(QUEUE_NAMES.agentExecution, {
      connection: { url: redis.url },
      prefix: queue.prefix,
    });
    inspector.on('error', () => undefined);
    producer.init();
  };

  afterEach(async () => {
    handler.open();
    await runner.stop();
    await producer.close();

    try {
      await inspector.obliterate({ force: true });
    } catch {
      // The queue may already be absent during test cleanup.
    }

    await inspector.close();
  });

  it('publishes and consumes a job end to end', async () => {
    boot(10_000);
    runner.start();

    const published = await producer.publish(
      QUEUE_NAMES.agentExecution,
      'execute',
      { marker: 'first' },
    );

    expect(published.jobId).not.toBe('');

    await until(() => handler.finished.includes('first'));

    expect(handler.finished).toEqual(['first']);
  }, 30_000);

  describe('SIGTERM arrives while a job is active', () => {
    it('drains the active job, claims no new one, and loses nothing', async () => {
      boot(10_000);
      handler.close();
      runner.start();

      await producer.publish(QUEUE_NAMES.agentExecution, 'execute', {
        marker: 'active',
      });
      await until(() => handler.started.includes('active'));

      await producer.publish(QUEUE_NAMES.agentExecution, 'execute', {
        marker: 'queued',
      });

      const stopping = runner.stop();

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(handler.started).toEqual(['active']);

      handler.open();
      await stopping;

      expect(handler.finished).toEqual(['active']);

      expect(handler.started).toEqual(['active']);

      const counts = await inspector.getJobCounts('waiting', 'active');
      expect((counts.waiting ?? 0) + (counts.active ?? 0)).toBe(1);
    }, 30_000);

    it('forces the close when the grace period expires, leaving the job recoverable', async () => {
      boot(0);
      handler.close();
      runner.start();

      await producer.publish(QUEUE_NAMES.agentExecution, 'execute', {
        marker: 'interrupted',
      });
      await until(() => handler.started.includes('interrupted'));

      await runner.stop();

      expect(handler.finished).toEqual([]);

      const counts = await inspector.getJobCounts(
        'completed',
        'failed',
        'active',
        'waiting',
      );
      expect(counts.completed).toBe(0);
      expect(counts.failed).toBe(0);
      expect((counts.active ?? 0) + (counts.waiting ?? 0)).toBe(1);
    }, 30_000);
  });

  it('is idempotent to stop twice', async () => {
    boot(10_000);
    runner.start();

    await runner.stop();

    await expect(runner.stop()).resolves.toBeUndefined();
  }, 30_000);

  it('deduplicates a re-published job by id', async () => {
    boot(10_000);
    handler.close();

    const first = await producer.publish(
      QUEUE_NAMES.agentExecution,
      'execute',
      { marker: 'once' },
      { jobId: 'run-42' },
    );
    const second = await producer.publish(
      QUEUE_NAMES.agentExecution,
      'execute',
      { marker: 'once' },
      { jobId: 'run-42' },
    );

    expect(first.jobId).toBe('run-42');
    expect(second.jobId).toBe('run-42');

    expect(await inspector.getJobCounts('waiting')).toMatchObject({
      waiting: 1,
    });

    runner.start();
    await until(() => handler.started.length > 0);
    expect(handler.started).toEqual(['once']);
  }, 30_000);
});

describe('queue publish with Redis unreachable (e2e)', () => {
  //
  const unreachable = {
    ...redis,
    url: 'redis://127.0.0.1:9',
    connectTimeoutMs: 150,
    commandTimeoutMs: 150,
  };
  let producer: QueueProducer;

  beforeEach(() => {
    producer = new QueueProducer(
      unreachable,
      queueConfigWith({ shutdownGraceMs: 0 }),
      silent,
    );
  });

  afterEach(async () => {
    await producer.close();
  });

  it('fails the publish instead of hanging', async () => {
    const startedAt = Date.now();

    await expect(
      producer.publish(QUEUE_NAMES.agentExecution, 'execute', { marker: 'x' }),
    ).rejects.toBeInstanceOf(QueuePublishError);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 30_000);
});
