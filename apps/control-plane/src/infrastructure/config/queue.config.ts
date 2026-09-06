import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  QUEUE_PREFIX: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]+$/,
      'QUEUE_PREFIX may contain only letters, digits, "_" and "-"',
    )
    .default('bmq'),

  QUEUE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),

  QUEUE_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),

  QUEUE_JOB_BACKOFF_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300_000)
    .default(2_000),

  QUEUE_COMPLETED_AGE_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(2_592_000)
    .default(3_600),
  QUEUE_COMPLETED_COUNT: z.coerce
    .number()
    .int()
    .min(0)
    .max(100_000)
    .default(1_000),

  QUEUE_FAILED_AGE_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(7_776_000)
    .default(604_800),
  QUEUE_FAILED_COUNT: z.coerce
    .number()
    .int()
    .min(0)
    .max(100_000)
    .default(5_000),

  QUEUE_SHUTDOWN_GRACE_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(300_000)
    .default(25_000),

  OUTBOX_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(60_000)
    .default(1_000),

  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),

  OUTBOX_LEASE_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(30_000),

  OUTBOX_WARN_AFTER_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(10),
});

export default registerAs('queue', () => {
  const env = schema.parse(process.env);

  return {
    prefix: env.QUEUE_PREFIX,
    workerConcurrency: env.QUEUE_WORKER_CONCURRENCY,
    shutdownGraceMs: env.QUEUE_SHUTDOWN_GRACE_MS,

    job: {
      attempts: env.QUEUE_JOB_ATTEMPTS,
      backoffMs: env.QUEUE_JOB_BACKOFF_MS,
    },

    retention: {
      completed: {
        ageSeconds: env.QUEUE_COMPLETED_AGE_SECONDS,
        count: env.QUEUE_COMPLETED_COUNT,
      },
      failed: {
        ageSeconds: env.QUEUE_FAILED_AGE_SECONDS,
        count: env.QUEUE_FAILED_COUNT,
      },
    },

    outbox: {
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      leaseMs: env.OUTBOX_LEASE_MS,
      warnAfterAttempts: env.OUTBOX_WARN_AFTER_ATTEMPTS,
    },
  };
});
