import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import queueConfig from '../../../../src/infrastructure/config/queue.config';

const KEYS = [
  'QUEUE_PREFIX',
  'QUEUE_WORKER_CONCURRENCY',
  'QUEUE_JOB_ATTEMPTS',
  'QUEUE_JOB_BACKOFF_MS',
  'QUEUE_COMPLETED_AGE_SECONDS',
  'QUEUE_COMPLETED_COUNT',
  'QUEUE_FAILED_AGE_SECONDS',
  'QUEUE_FAILED_COUNT',
  'QUEUE_SHUTDOWN_GRACE_MS',
  'OUTBOX_POLL_INTERVAL_MS',
  'OUTBOX_BATCH_SIZE',
  'OUTBOX_LEASE_MS',
  'OUTBOX_WARN_AFTER_ATTEMPTS',
];

describe('queueConfig', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    process.env = original;
  });

  it('boots with no queue variables set at all', () => {
    expect(queueConfig()).toEqual({
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
    });
  });

  it('retains failures far longer than completions', () => {
    const { retention } = queueConfig();

    expect(retention.failed.ageSeconds).toBe(7 * 24 * 60 * 60);
    expect(retention.failed.ageSeconds).toBeGreaterThan(
      retention.completed.ageSeconds,
    );
    expect(retention.failed.count).toBeGreaterThan(retention.completed.count);
  });

  it('reads an explicit namespace and worker concurrency', () => {
    process.env.QUEUE_PREFIX = 'agents-bmq';
    process.env.QUEUE_WORKER_CONCURRENCY = '16';

    expect(queueConfig()).toMatchObject({
      prefix: 'agents-bmq',
      workerConcurrency: 16,
    });
  });

  it('reads the outbox delivery knobs', () => {
    process.env.OUTBOX_POLL_INTERVAL_MS = '250';
    process.env.OUTBOX_BATCH_SIZE = '10';
    process.env.OUTBOX_LEASE_MS = '5000';
    process.env.OUTBOX_WARN_AFTER_ATTEMPTS = '3';

    expect(queueConfig().outbox).toEqual({
      pollIntervalMs: 250,
      batchSize: 10,
      leaseMs: 5_000,
      warnAfterAttempts: 3,
    });
  });

  it('allows retention to be reduced to nothing but keeps the shape', () => {
    process.env.QUEUE_COMPLETED_AGE_SECONDS = '0';
    process.env.QUEUE_COMPLETED_COUNT = '0';

    expect(queueConfig().retention.completed).toEqual({
      ageSeconds: 0,
      count: 0,
    });
  });

  describe('fail-fast', () => {
    it('rejects a namespace containing pattern or hash-tag characters', () => {
      process.env.QUEUE_PREFIX = 'bmq{1}';

      expect(() => queueConfig()).toThrow(/QUEUE_PREFIX/);
    });

    it('rejects an empty namespace', () => {
      process.env.QUEUE_PREFIX = '';

      expect(() => queueConfig()).toThrow(/QUEUE_PREFIX/);
    });

    it('rejects zero concurrency, which would process nothing', () => {
      process.env.QUEUE_WORKER_CONCURRENCY = '0';

      expect(() => queueConfig()).toThrow();
    });

    it('rejects concurrency high enough to be a cost incident', () => {
      process.env.QUEUE_WORKER_CONCURRENCY = '5000';

      expect(() => queueConfig()).toThrow();
    });

    it('rejects zero attempts, which would never run the job', () => {
      process.env.QUEUE_JOB_ATTEMPTS = '0';

      expect(() => queueConfig()).toThrow();
    });

    it('rejects a lease too short to survive scheduling jitter', () => {
      process.env.OUTBOX_LEASE_MS = '10';

      expect(() => queueConfig()).toThrow();
    });

    it('rejects a shutdown grace period long enough to be SIGKILLed', () => {
      process.env.QUEUE_SHUTDOWN_GRACE_MS = '600000';

      expect(() => queueConfig()).toThrow();
    });

    it('rejects a non-numeric value rather than coercing it to NaN', () => {
      process.env.OUTBOX_BATCH_SIZE = 'all';

      expect(() => queueConfig()).toThrow();
    });
  });

  describe('the retry budget is an observability threshold, not a limit', () => {
    it('exposes no terminal attempt limit at all', () => {
      expect(queueConfig().outbox).not.toHaveProperty('maxAttempts');
      expect(Object.keys(queueConfig().outbox)).toEqual([
        'pollIntervalMs',
        'batchSize',
        'leaseMs',
        'warnAfterAttempts',
      ]);
    });

    it('no longer answers to the old variable name', () => {
      process.env.OUTBOX_MAX_ATTEMPTS = '2';

      expect(queueConfig().outbox.warnAfterAttempts).toBe(10);
    });
  });
});
