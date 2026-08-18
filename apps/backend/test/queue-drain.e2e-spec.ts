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
} from '../src/core/queue';

/**
 * The shutdown policy, exercised against a real Redis.
 *
 * This is the suite the Phase 1 acceptance criterion asks for: a worker told to
 * stop must claim no new job, must let an in-flight job finish, and must leave
 * nothing in a state that only a human could repair. None of that can be
 * demonstrated against a mock — the behaviour under test is BullMQ's fetch loop
 * and its lock handling, not our call into it.
 *
 * Built by hand rather than through Nest, for two reasons: every configuration
 * value that matters here (the grace period above all) has to differ per test,
 * and each test needs its own Redis namespace so a leftover job cannot make the
 * next one pass or fail for the wrong reason.
 */

const redis = {
  url: process.env.REDIS_URL ?? 'redis://localhost:6378',
  keyPrefix: 'queue-drain-test:',
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 2_000,
  maxRetriesPerRequest: 2,
};

let namespace = 0;

const queueConfigWith = (overrides: { shutdownGraceMs: number }) => ({
  // A fresh namespace per test. `obliterate` in teardown then removes exactly
  // this test's keys and can touch nothing else, which is what makes running
  // the suite against a shared Redis safe.
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
    maxAttempts: 3,
  },
});

const silent = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

/** A handler whose completion the test controls. */
class GatedHandler implements QueueJobHandler<{ marker: string }> {
  readonly queue = QUEUE_NAMES.agentExecution;
  readonly jobName = 'execute';

  readonly started: string[] = [];
  readonly finished: string[] = [];

  private release: (() => void) | undefined;
  private gate = Promise.resolve();

  /** Makes every subsequent job block until `open()` is called. */
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

  /**
   * Called by each test with the grace period that test is about. Not a
   * `beforeEach`: the forced-close case needs a grace of zero, and booting a
   * second set on top of a first would leave the first set's Redis connections
   * open — which does not fail an assertion, it just stops the runner exiting.
   */
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
      // Scoped to this test's own prefix, so nothing outside it is affected.
      await inspector.obliterate({ force: true });
    } catch {
      // A queue that was never created has nothing to obliterate.
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

  /**
   * The acceptance criterion, stated as three separate facts because they fail
   * separately: the in-flight job finishes, the queued one is not started, and
   * the queued one is still there afterwards.
   */
  describe('SIGTERM arrives while a job is active', () => {
    it('drains the active job, claims no new one, and loses nothing', async () => {
      boot(10_000);
      handler.close();
      runner.start();

      await producer.publish(QUEUE_NAMES.agentExecution, 'execute', {
        marker: 'active',
      });
      await until(() => handler.started.includes('active'));

      // Queued behind the active one. Concurrency is 1, so it cannot start
      // until the first finishes — and it must not, once shutdown has begun.
      await producer.publish(QUEUE_NAMES.agentExecution, 'execute', {
        marker: 'queued',
      });

      const stopping = runner.stop();

      // Shutdown has begun and the active job is still blocked. Give the fetch
      // loop time to misbehave if it is going to.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(handler.started).toEqual(['active']);

      handler.open();
      await stopping;

      // Drained, not abandoned.
      expect(handler.finished).toEqual(['active']);

      // Never claimed. This is the half that a "stop accepting work" flag alone
      // would get wrong.
      expect(handler.started).toEqual(['active']);

      // And still queued, for the next process to pick up. A deployment must
      // not consume work it did not perform.
      const counts = await inspector.getJobCounts('waiting', 'active');
      expect((counts.waiting ?? 0) + (counts.active ?? 0)).toBe(1);
    }, 30_000);

    /**
     * The other side of the bound. An orchestrator will `SIGKILL` a process that
     * overruns its termination grace period, so the runner gives up first — and
     * what matters is that giving up is *safe*: the job is neither completed nor
     * failed, so BullMQ's stalled-job recovery returns it to the queue.
     *
     * This is also why deployment shutdown must never be written as a
     * cancellation. Nothing here has decided the work should not happen.
     */
    it('forces the close when the grace period expires, leaving the job recoverable', async () => {
      boot(0);
      handler.close();
      runner.start();

      await producer.publish(QUEUE_NAMES.agentExecution, 'execute', {
        marker: 'interrupted',
      });
      await until(() => handler.started.includes('interrupted'));

      await runner.stop();

      // The handler never got to finish, and nothing pretended it did.
      expect(handler.finished).toEqual([]);

      const counts = await inspector.getJobCounts(
        'completed',
        'failed',
        'active',
        'waiting',
      );
      expect(counts.completed).toBe(0);
      expect(counts.failed).toBe(0);
      // Still held by the abandoned lock, which is exactly what the stalled
      // checker looks for.
      expect((counts.active ?? 0) + (counts.waiting ?? 0)).toBe(1);
    }, 30_000);
  });

  it('is idempotent to stop twice', async () => {
    boot(10_000);
    runner.start();

    await runner.stop();

    await expect(runner.stop()).resolves.toBeUndefined();
  }, 30_000);

  /**
   * The queue-level half of the idempotency story. Not the durable half: BullMQ
   * refuses a duplicate id only while the job still exists in Redis, so once
   * retention evicts it the same id is accepted again. That is why the durable
   * guarantee is a PostgreSQL UNIQUE constraint and this is a fast path for the
   * duplicates that arrive close together — which is precisely the shape of a
   * re-delivered outbox event.
   */
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

    // Both publishes report the same id, and neither reports having been
    // rejected. BullMQ's add script returns the existing id for a duplicate, so
    // there is nothing to report — which is why the assertion below is about the
    // queue rather than about the return value.
    expect(first.jobId).toBe('run-42');
    expect(second.jobId).toBe('run-42');

    expect(await inspector.getJobCounts('waiting')).toMatchObject({
      waiting: 1,
    });

    // Started only after the counts are asserted, so the queue is inspected
    // while both jobs would still be waiting if there were two.
    runner.start();
    await until(() => handler.started.length > 0);
    expect(handler.started).toEqual(['once']);
  }, 30_000);
});

/**
 * Publishing against a Redis that is not there.
 *
 * The one behaviour the outbox contract rests on: the publish has to *return*.
 * BullMQ resolves `add()` against a connection promise that waits for `ready`
 * and deliberately does not reject while the client is still reconnecting, so
 * without the bound in `QueueProducer` this call would never settle and the
 * dispatcher loop would stop advancing behind a single await.
 */
describe('queue publish with Redis unreachable (e2e)', () => {
  // Port 9 is TCP discard: closed, and nothing in this project ever binds it.
  //
  // The tight `commandTimeoutMs` does double duty. It bounds the publish, which
  // is what this suite is about, and it bounds the close: ioredis derives its
  // `disconnectTimeout` from the same value, and that timer only clears when the
  // socket reports `close` — which a socket that never connected never does.
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

    // Bounded by the configured command timeout, not by the outage.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 30_000);
});
