import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * Queue transport and delivery policy.
 *
 * Values only. The mapping onto BullMQ's option shapes lives in
 * `src/infrastructure/queue`, for the same reason `mail.config.ts` holds
 * driver settings while `mail.module.ts` decides which class they construct:
 * configuration that imports a library's types starts making the library's
 * decisions, and the retention invariant below has to be enforced in code that
 * cannot be overridden by an environment variable.
 */
const schema = z.object({
  /**
   * BullMQ's *own* key namespace, passed to its `prefix` option.
   *
   * Kept separate from `REDIS_KEY_PREFIX` because the two are applied by
   * different mechanisms: BullMQ builds its key names inside Lua scripts and
   * must be told the prefix, whereas ioredis rewrites keys on the way out.
   * Mixing them corrupts the scripts (see `redis.config.ts`).
   *
   * Default `bmq` rather than BullMQ's own `bull`, so a key sighted in a shared
   * keyspace identifies which application put it there.
   */
  QUEUE_PREFIX: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]+$/,
      'QUEUE_PREFIX may contain only letters, digits, "_" and "-"',
    )
    .default('bmq'),

  /**
   * Jobs a single worker process may run at once.
   *
   * This is the first and cheapest concurrency guardrail in the system: it
   * bounds simultaneous LLM and tool work per process without any distributed
   * coordination, which is why per-tenant limits can be built later on top of
   * it rather than in place of it.
   */
  QUEUE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),

  /** Total attempts per job, the first included. */
  QUEUE_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),

  /** Base delay for exponential backoff between attempts. */
  QUEUE_JOB_BACKOFF_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300_000)
    .default(2_000),

  /**
   * Retention for *completed* jobs — short, because a completed job's durable
   * record already exists in PostgreSQL and the Redis copy is only useful for
   * a few minutes of live inspection.
   */
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

  /**
   * Retention for *failed* jobs — a week, because this is the only place the
   * stack trace, the attempt history and the exact payload survive together.
   * Discarding a failed job discards the incident.
   */
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

  /**
   * How long `worker.close()` may wait for jobs already in flight.
   *
   * Bounded so an orchestrator's own `SIGKILL` deadline is never the thing
   * that decides: a worker that overruns its grace period gets killed
   * mid-write, whereas one that stops first leaves the job stalled and
   * recoverable.
   */
  QUEUE_SHUTDOWN_GRACE_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(300_000)
    .default(25_000),

  /** How often the dispatcher looks for pending outbox events. */
  OUTBOX_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(60_000)
    .default(1_000),

  /** Events claimed per pass. */
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),

  /**
   * How long a claimed event stays claimed.
   *
   * This is the crash-recovery window, and the whole at-least-once guarantee
   * rests on it: a dispatcher that dies between `queue.add()` and the
   * `DELIVERED` write leaves the event claimed, and nothing re-delivers it
   * until the lease expires. Too short and two dispatchers publish the same
   * event routinely; too long and a crash stalls delivery for minutes.
   */
  OUTBOX_LEASE_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(30_000),

  /**
   * Attempts after which a still-undelivered event is logged as a problem.
   *
   * Purely observational. It was `OUTBOX_MAX_ATTEMPTS`, a terminal delivery
   * budget, and that was wrong in a way the readiness contract makes obvious:
   * the API stays ready while Redis is down precisely because accepted work is
   * durable in PostgreSQL, so an outage lasting longer than ten poll intervals
   * would have parked every event it had promised to deliver. A transport outage
   * is not poison data, and no counter should turn one into the other.
   *
   * Transient publish failures are now retried indefinitely with capped backoff.
   * This threshold only decides when the retries start being reported loudly,
   * so an outage that has stopped being brief is visible in the logs rather than
   * inferred from a queue that is quietly not moving.
   */
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

    /**
     * Age is in seconds because that is the unit BullMQ's `KeepJobs` takes;
     * converting here would only invite a second conversion later.
     */
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
