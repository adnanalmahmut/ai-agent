import type { ConfigType } from '@nestjs/config';
import type { QueueOptions, WorkerOptions } from 'bullmq';

import type { queueConfig, redisConfig } from '../config';
import { buildRedisConnectionOptions } from '../redis';

export const QUEUE_NAMES = {
  agentExecution: 'agent-execution',
  knowledgeEmbedding: 'knowledge-embedding',
  toolSideEffect: 'tool-side-effect',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUE_NAMES);

export const QUEUE_JOB_HANDLERS = Symbol('QUEUE_JOB_HANDLERS');

type RedisConfig = ConfigType<typeof redisConfig>;
type QueueConfig = ConfigType<typeof queueConfig>;

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

export function buildQueueOptions(
  redis: RedisConfig,
  queue: QueueConfig,
): QueueOptions {
  return {
    connection: buildRedisConnectionOptions('queue-producer', redis),
    prefix: queue.prefix,
    defaultJobOptions: {
      attempts: queue.job.attempts,
      backoff: { type: 'exponential', delay: queue.job.backoffMs },
      ...retentionOf(queue),
    },
  };
}

export function buildWorkerOptions(
  redis: RedisConfig,
  queue: QueueConfig,
): WorkerOptions {
  return {
    connection: buildRedisConnectionOptions('queue-worker', redis),
    prefix: queue.prefix,
    concurrency: queue.workerConcurrency,
    ...retentionOf(queue),
    autorun: false,
  };
}
