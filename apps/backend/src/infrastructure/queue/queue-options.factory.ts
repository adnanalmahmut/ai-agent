import type { ConfigType } from '@nestjs/config';
import type { QueueOptions, WorkerOptions } from 'bullmq';

import type { queueConfig, redisConfig } from '../../config';
import { buildRedisConnectionOptions } from '../redis';

type RedisConfig = ConfigType<typeof redisConfig>;
type QueueConfig = ConfigType<typeof queueConfig>;

/**
 * The retention policy, in BullMQ's own shape.
 *
 * `KeepJobs` objects rather than booleans, and never `removeOnFail: true`. That
 * one line is the difference between an incident that can be investigated and
 * an incident that cannot: the failed job is the only place its stack trace, its
 * attempt history and its exact payload survive together, and `true` deletes all
 * three at the moment they become interesting.
 *
 * The asymmetry between the two windows is deliberate. A completed job's durable
 * record already exists in PostgreSQL, so keeping the Redis copy for an hour is
 * a convenience; a failed job is evidence, so it is kept for a week.
 */
function retentionOf(queue: QueueConfig) {
  return {
    removeOnComplete: {
      age: queue.retention.completed.ageSeconds,
      count: queue.retention.completed.count,
    },
    removeOnFail: {
      age: queue.retention.failed.ageSeconds,
      count: queue.retention.failed.count,
    },
  } as const;
}

/**
 * Producer-side options: what a `Queue` needs to publish.
 *
 * `prefix` is BullMQ's namespace and the only correct way to namespace it. The
 * connection comes from the `queue-producer` role, which retries a finite number
 * of times so a failed publish returns control to its caller rather than
 * blocking on an outage.
 */
export function buildQueueOptions(
  redis: RedisConfig,
  queue: QueueConfig,
): QueueOptions {
  return {
    connection: buildRedisConnectionOptions('queue-producer', redis),
    prefix: queue.prefix,
    defaultJobOptions: {
      attempts: queue.job.attempts,
      /**
       * Exponential, not fixed. The failures worth retrying here are provider
       * rate limits and transient outages, and a fixed delay retried in lockstep
       * across a fleet of workers reproduces the overload it is recovering from.
       */
      backoff: { type: 'exponential', delay: queue.job.backoffMs },
      ...retentionOf(queue),
    },
  };
}

/**
 * Consumer-side options: what a `Worker` needs to process.
 *
 * The retention settings are repeated here rather than left to the producer's
 * defaults because BullMQ evaluates them where the job finishes. A worker
 * without them keeps every completed and failed job forever, which is how a
 * queue Redis reaches its memory limit under a `noeviction` policy and starts
 * refusing writes.
 */
export function buildWorkerOptions(
  redis: RedisConfig,
  queue: QueueConfig,
): WorkerOptions {
  return {
    connection: buildRedisConnectionOptions('queue-worker', redis),
    prefix: queue.prefix,
    concurrency: queue.workerConcurrency,
    ...retentionOf(queue),
    /**
     * Started explicitly by the worker entrypoint rather than on construction.
     *
     * The shutdown sequence has an order, and so does startup: a worker that
     * begins claiming jobs while the process is still wiring up its dispatcher
     * and its readiness state can be asked to shut down before it is ready to.
     */
    autorun: false,
  };
}
