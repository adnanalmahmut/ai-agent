import { describe, expect, it } from '@jest/globals';

import { buildQueueOptions, buildWorkerOptions } from './queue-options.factory';

const redis = {
  url: 'redis://localhost:6379',
  keyPrefix: 'app:',
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 2_000,
  maxRetriesPerRequest: 2,
};

const queue = {
  prefix: 'bmq',
  workerConcurrency: 4,
  shutdownGraceMs: 25_000,
  job: { attempts: 3, backoffMs: 2_000 },
  retention: {
    completed: { ageSeconds: 3_600, count: 1_000 },
    failed: { ageSeconds: 604_800, count: 5_000 },
  },
  outbox: {
    pollIntervalMs: 1_000,
    batchSize: 50,
    leaseMs: 30_000,
    warnAfterAttempts: 10,
  },
};

describe('buildQueueOptions (producer)', () => {
  const options = buildQueueOptions(redis, queue);

  /**
   * The supported namespacing mechanism, and the only one that works. BullMQ
   * computes key names inside its Lua scripts, so a client-side ioredis prefix
   * would leave the scripts addressing keys nobody wrote.
   */
  it('namespaces through BullMQ rather than through the client', () => {
    expect(options.prefix).toBe('bmq');
    expect(options.connection).not.toHaveProperty('keyPrefix');
  });

  it('publishes over the finite-retry producer connection', () => {
    // Not the worker's `null`. A publish must be able to fail so the outbox
    // dispatcher regains control and can retry the event later.
    expect(options.connection).toMatchObject({ maxRetriesPerRequest: 2 });
  });

  /**
   * Exponential rather than fixed. The failures worth retrying are provider rate
   * limits and transient outages, and a fixed delay retried in lockstep across a
   * fleet reproduces the overload it is recovering from.
   */
  it('retries with exponential backoff', () => {
    expect(options.defaultJobOptions).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
    });
  });

  it('carries the retention windows as age-and-count objects', () => {
    expect(options.defaultJobOptions).toMatchObject({
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 604_800, count: 5_000 },
    });
  });
});

describe('buildWorkerOptions (consumer)', () => {
  const options = buildWorkerOptions(redis, queue);

  it('consumes over the blocking worker connection', () => {
    expect(options.connection).toMatchObject({ maxRetriesPerRequest: null });
    expect(options.connection).not.toHaveProperty('commandTimeout');
    expect(options.connection).not.toHaveProperty('keyPrefix');
  });

  it('shares the producer namespace, or it would read an empty queue', () => {
    expect(options.prefix).toBe(buildQueueOptions(redis, queue).prefix);
  });

  it('bounds in-process parallelism', () => {
    expect(options.concurrency).toBe(4);
  });

  /**
   * Not started on construction. The shutdown sequence has an order and so does
   * startup: a worker that begins claiming jobs while the process is still
   * wiring its dispatcher and readiness state can be asked to stop before it is
   * ready to.
   */
  it('does not start fetching until told to', () => {
    expect(options.autorun).toBe(false);
  });

  /**
   * BullMQ evaluates retention where the job finishes, which is here. A worker
   * without these keeps every completed and failed job forever — and under the
   * `noeviction` policy the queue Redis requires, that ends as a Redis at its
   * memory limit refusing writes rather than as a Redis quietly dropping keys.
   */
  it('repeats retention on the consumer side, where it is applied', () => {
    expect(options.removeOnComplete).toEqual({ age: 3_600, count: 1_000 });
    expect(options.removeOnFail).toEqual({ age: 604_800, count: 5_000 });
  });
});

/**
 * The single most consequential line in this file, asserted on both sides.
 *
 * `removeOnFail: true` deletes a job's stack trace, attempt history and exact
 * payload at the moment they become the only record of the incident. It is also
 * the shortest thing to type, which is exactly why it is pinned here rather than
 * left to review.
 */
describe('retention policy invariants', () => {
  const producer = buildQueueOptions(redis, queue);
  const worker = buildWorkerOptions(redis, queue);

  it('never expresses retention as a boolean', () => {
    for (const value of [
      producer.defaultJobOptions?.removeOnComplete,
      producer.defaultJobOptions?.removeOnFail,
      worker.removeOnComplete,
      worker.removeOnFail,
    ]) {
      expect(typeof value).toBe('object');
      expect(value).not.toBe(true);
    }
  });

  it('keeps failures longer than completions on both sides', () => {
    const failedAge = (value: unknown) => (value as { age: number }).age;

    expect(failedAge(producer.defaultJobOptions?.removeOnFail)).toBeGreaterThan(
      failedAge(producer.defaultJobOptions?.removeOnComplete),
    );
    expect(failedAge(worker.removeOnFail)).toBeGreaterThan(
      failedAge(worker.removeOnComplete),
    );
  });

  it('applies identical windows to producer and consumer', () => {
    expect(worker.removeOnComplete).toEqual(
      producer.defaultJobOptions?.removeOnComplete,
    );
    expect(worker.removeOnFail).toEqual(
      producer.defaultJobOptions?.removeOnFail,
    );
  });
});
