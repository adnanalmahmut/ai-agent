/**
 * The queue transport's two pure surfaces: the BullMQ options built from
 * configuration, and the failure classification that decides whether a publish
 * is retried.
 *
 * One suite because both answer the same question from opposite ends — what
 * happens to a job when Redis is unhealthy.
 */
import { describe, expect, it } from '@jest/globals';

import {
  QueuePublishError,
  classifyPublishError,
} from '../queue-publish.error';
import { buildQueueOptions, buildWorkerOptions } from '../queue.config';

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

/**
 * The classification that decides whether durably accepted work survives an
 * outage.
 *
 * The two mistakes are not equally expensive, and the tests are written around
 * that asymmetry. Calling a poison event transient costs one retry per backoff
 * interval and leaves a row visibly stuck. Calling a transport outage permanent
 * destroys work the API has already told a caller it accepted — and does it
 * precisely when the system is under stress and nobody is reading logs closely.
 */
describe('classifyPublishError', () => {
  /**
   * Every one of these is something a real Redis or ioredis emits during an
   * outage. None of them is enumerated in the implementation — they are all
   * covered by "unknown means transient" — which is the point: this list can
   * grow when a driver rewords a message and the classification still holds.
   */
  describe('transport failures are transient', () => {
    const transportErrors = [
      'connect ECONNREFUSED 127.0.0.1:6379',
      'read ECONNRESET',
      'connect ETIMEDOUT',
      'write EPIPE',
      'getaddrinfo ENOTFOUND redis',
      'Connection is closed.',
      "Stream isn't writeable and enableOfflineQueue options is false",
      'Reached the max retries per request limit (which is 2).',
      'Command timed out',
      "OOM command not allowed when used memory > 'maxmemory'.",
      'LOADING Redis is loading the dataset in memory',
      'CLUSTERDOWN Hash slot not served',
      "READONLY You can't write against a read only replica.",
    ];

    it.each(transportErrors)('%s', (message) => {
      expect(classifyPublishError(new Error(message))).toBe('transient');
    });
  });

  /**
   * Only failures whose outcome is a property of the *event* rather than of the
   * transport. The thousandth attempt fails exactly like the first.
   */
  describe('deterministic failures are permanent', () => {
    const permanentErrors = [
      'Converting circular structure to JSON',
      'Do not know how to serialize a BigInt',
      'The size of job execute exceeds the limit 1024 bytes',
    ];

    it.each(permanentErrors)('%s', (message) => {
      expect(classifyPublishError(new Error(message))).toBe('permanent');
    });
  });

  /**
   * The default, and the safety property. An unrecognised error could be
   * anything; treating it as transient means the worst case is a retry, whereas
   * treating it as permanent means the worst case is lost work.
   */
  describe('the unknown is transient', () => {
    it.each([
      'EPROTO something nobody has seen before',
      'Unexpected server response: 500',
      '',
    ])('%s', (message) => {
      expect(classifyPublishError(new Error(message))).toBe('transient');
    });

    it('classifies a non-Error rejection as transient', () => {
      expect(classifyPublishError('just a string')).toBe('transient');
      expect(classifyPublishError(undefined)).toBe('transient');
      expect(classifyPublishError({ code: 'ECONNRESET' })).toBe('transient');
    });
  });
});

describe('QueuePublishError', () => {
  /**
   * A timeout is a statement about the transport, never about the event: it says
   * the queue did not answer in time. Classifying it from a message would be
   * fragile for no gain.
   */
  it('is always transient when the publish timed out', () => {
    const error = new QueuePublishError(
      'agent-execution',
      'timeout',
      'Publishing to "agent-execution" exceeded 2000ms',
    );

    expect(error.kind).toBe('transient');
  });

  it('classifies a rejection from its cause', () => {
    const cause = new Error('Converting circular structure to JSON');
    const error = new QueuePublishError(
      'agent-execution',
      'rejected',
      cause.message,
      cause,
    );

    expect(error.kind).toBe('permanent');
  });

  it('falls back to its own message when there is no cause', () => {
    expect(
      new QueuePublishError(
        'agent-execution',
        'rejected',
        'connect ECONNREFUSED',
      ).kind,
    ).toBe('transient');
  });

  it('keeps the queue name and reason for the caller', () => {
    const error = new QueuePublishError('agent-execution', 'timeout', 'slow');

    expect(error.queue).toBe('agent-execution');
    expect(error.reason).toBe('timeout');
    expect(error.name).toBe('QueuePublishError');
    expect(error).toBeInstanceOf(Error);
  });
});
