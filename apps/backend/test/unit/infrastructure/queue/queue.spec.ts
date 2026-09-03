import { describe, expect, it } from '@jest/globals';

import {
  QueuePublishError,
  classifyPublishError,
} from '../../../../src/infrastructure/queue/queue-publish.error';
import {
  buildQueueOptions,
  buildWorkerOptions,
} from '../../../../src/infrastructure/queue/queue.config';

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

  it('namespaces through BullMQ rather than through the client', () => {
    expect(options.prefix).toBe('bmq');
    expect(options.connection).not.toHaveProperty('keyPrefix');
  });

  it('publishes over the finite-retry producer connection', () => {
    expect(options.connection).toMatchObject({ maxRetriesPerRequest: 2 });
  });

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

  it('does not start fetching until told to', () => {
    expect(options.autorun).toBe(false);
  });

  it('repeats retention on the consumer side, where it is applied', () => {
    expect(options.removeOnComplete).toEqual({ age: 3_600, count: 1_000 });
    expect(options.removeOnFail).toEqual({ age: 604_800, count: 5_000 });
  });
});

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

describe('classifyPublishError', () => {
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
