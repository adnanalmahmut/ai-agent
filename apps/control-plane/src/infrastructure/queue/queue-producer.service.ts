import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { queueConfig, redisConfig } from '../config';
import { QueuePublishError } from './queue-publish.error';
import {
  ALL_QUEUE_NAMES,
  buildQueueOptions,
  type QueueName,
} from './queue.config';

export type PublishOptions = {
  jobId?: string;
};

export type PublishResult = {
  jobId: string;
};

export type QueueJobTransportState = 'failed' | 'missing' | 'pending';

@Injectable()
export class QueueProducer {
  private readonly queues = new Map<QueueName, Queue>();

  private closed = false;

  private readonly publishTimeoutMs: number;

  constructor(
    @Inject(redisConfig.KEY)
    private readonly redis: ConfigType<typeof redisConfig>,
    @Inject(queueConfig.KEY)
    private readonly queue: ConfigType<typeof queueConfig>,
    private readonly logger: PinoLogger,
  ) {
    this.publishTimeoutMs = redis.commandTimeoutMs;
  }

  init(): void {
    for (const name of ALL_QUEUE_NAMES) this.queueFor(name);
  }

  private queueFor(name: QueueName): Queue {
    if (this.closed) {
      throw new QueuePublishError(
        name,
        'rejected',
        `Queue "${name}" is closed`,
      );
    }

    const existing = this.queues.get(name);
    if (existing) return existing;

    const created = new Queue(name, buildQueueOptions(this.redis, this.queue));

    created.on('error', (error: Error) => {
      this.logger.warn(
        { queue: name, err: { name: error.name, message: error.message } },
        'Queue connection error; publishing is degraded',
      );
    });

    this.queues.set(name, created);
    return created;
  }

  async publish(
    name: QueueName,
    jobName: string,
    data: unknown,
    options: PublishOptions = {},
  ): Promise<PublishResult> {
    const queue = this.queueFor(name);

    try {
      const job = await this.bounded(
        name,
        'Publishing',
        queue.add(jobName, data, { jobId: options.jobId }),
      );

      return { jobId: job.id ?? options.jobId ?? '' };
    } catch (error) {
      if (error instanceof QueuePublishError) throw error;

      throw new QueuePublishError(
        name,
        'rejected',
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }

  private async bounded<T>(
    name: QueueName,
    operation: string,
    work: Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new QueuePublishError(
                  name,
                  'timeout',
                  `${operation} on "${name}" exceeded ${this.publishTimeoutMs}ms`,
                ),
              ),
            this.publishTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async jobTransportState(
    name: QueueName,
    jobId: string,
  ): Promise<QueueJobTransportState> {
    const state = await this.bounded(
      name,
      'Reading job state',
      this.queueFor(name).getJobState(jobId),
    );

    if (state === 'failed') return 'failed';

    // BullMQ's own word for "no such job", which is also what retention leaves
    // behind once it removes one.
    if (state === 'unknown') return 'missing';

    return 'pending';
  }

  async close(): Promise<void> {
    const closing = [...this.queues.entries()].map(async ([name, queue]) => {
      try {
        await queue.close();
      } catch (error) {
        this.logger.warn(
          {
            queue: name,
            err: error instanceof Error ? { message: error.message } : {},
          },
          'Queue did not close cleanly',
        );
      }
    });

    await Promise.all(closing);
    this.queues.clear();
    this.closed = true;
  }
}
