import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { QueueEvents, UnrecoverableError, Worker, type Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { queueConfig, redisConfig } from '../config';
import type { QueueJobHandler } from './queue-job-handler';
import {
  buildWorkerOptions,
  QUEUE_JOB_HANDLERS,
  type QueueName,
} from './queue.config';

@Injectable()
export class QueueWorkerRunner {
  private readonly workers = new Map<QueueName, Worker>();
  private readonly events = new Map<QueueName, QueueEvents>();

  private readonly inFlight = new Map<QueueName, Set<Promise<void>>>();

  private readonly routes = new Map<
    QueueName,
    Map<string, QueueJobHandler<never>>
  >();

  constructor(
    @Inject(redisConfig.KEY)
    private readonly redis: ConfigType<typeof redisConfig>,
    @Inject(queueConfig.KEY)
    private readonly queue: ConfigType<typeof queueConfig>,
    @Inject(QUEUE_JOB_HANDLERS)
    handlers: QueueJobHandler<never>[],
    private readonly logger: PinoLogger,
  ) {
    for (const handler of handlers) {
      const forQueue =
        this.routes.get(handler.queue) ?? new Map<string, QueueJobHandler>();

      if (forQueue.has(handler.jobName)) {
        throw new Error(
          `Two handlers registered for job "${handler.jobName}" on queue "${handler.queue}"`,
        );
      }

      forQueue.set(handler.jobName, handler);
      this.routes.set(handler.queue, forQueue);
    }
  }

  get queueNames(): QueueName[] {
    return [...this.routes.keys()];
  }

  get isRunning(): boolean {
    return this.workers.size > 0;
  }

  start(): void {
    for (const [name, routes] of this.routes) {
      const worker = new Worker(
        name,
        (job: Job) => this.dispatch(name, routes, job),
        buildWorkerOptions(this.redis, this.queue),
      );

      worker.on('error', (error: Error) => {
        this.logger.warn(
          { queue: name, err: { name: error.name, message: error.message } },
          'Worker connection error',
        );
      });

      worker.on('stalled', (jobId: string) => {
        this.logger.warn(
          { queue: name, jobId },
          'Job stalled and was returned for reprocessing',
        );
      });

      this.workers.set(name, worker);

      // `autorun: false` means this is what actually begins the fetch loop.
      void worker.run();

      this.events.set(name, this.observe(name));
    }

    this.logger.info(
      { queues: this.queueNames, concurrency: this.queue.workerConcurrency },
      this.isRunning
        ? 'Queue workers started'
        : 'No queue handlers registered; no workers started',
    );
  }

  private observe(name: QueueName): QueueEvents {
    const events = new QueueEvents(name, {
      connection: buildWorkerOptions(this.redis, this.queue).connection,
      prefix: this.queue.prefix,
    });

    events.on('error', (error: Error) => {
      this.logger.warn(
        { queue: name, err: { name: error.name, message: error.message } },
        'Queue events connection error',
      );
    });

    events.on('failed', ({ jobId, failedReason }) => {
      this.logger.warn(
        { queue: name, jobId, failedReason },
        'Job failed after exhausting its attempts',
      );
    });

    return events;
  }

  private async dispatch(
    name: QueueName,
    routes: Map<string, QueueJobHandler<never>>,
    job: Job,
  ): Promise<void> {
    const handler = routes.get(job.name);

    if (!handler) {
      throw new UnrecoverableError(
        `No handler for job "${job.name}" on queue "${name}"`,
      );
    }

    const active = this.inFlight.get(name) ?? new Set<Promise<void>>();
    this.inFlight.set(name, active);

    const work = handler.handle(job as Job<never>);
    active.add(work);

    return work.finally(() => active.delete(work));
  }

  async stop(maxDrainMs = this.queue.shutdownGraceMs): Promise<void> {
    const grace = Math.max(Math.min(maxDrainMs, this.queue.shutdownGraceMs), 0);

    await Promise.all(
      [...this.workers.entries()].map(([name, worker]) =>
        this.closeWorker(name, worker, grace),
      ),
    );
    this.workers.clear();

    await Promise.all(
      [...this.events.entries()].map(async ([name, events]) => {
        try {
          await events.close();
        } catch (error) {
          this.logger.warn(
            {
              queue: name,
              err: error instanceof Error ? { message: error.message } : {},
            },
            'Queue events did not close cleanly',
          );
        }
      }),
    );
    this.events.clear();
  }

  private async closeWorker(
    name: QueueName,
    worker: Worker,
    graceMs: number,
  ): Promise<void> {
    try {
      await worker.pause(true);

      await this.awaitDrained(name, graceMs);

      const stranded = this.inFlight.get(name)?.size ?? 0;

      if (stranded > 0) {
        this.logger.warn(
          { queue: name, graceMs, stranded },
          'Jobs did not finish within the shutdown grace period; closing by ' +
            'force. They keep their durable state and are recovered as stalled.',
        );
      }

      await worker.close(stranded > 0);

      if (stranded === 0) {
        this.logger.info({ queue: name }, 'Worker drained and closed');
      }
    } catch (error) {
      // A shutdown step that throws strands every step behind it.
      this.logger.warn(
        {
          queue: name,
          err: error instanceof Error ? { message: error.message } : {},
        },
        'Worker did not close cleanly',
      );
    }
  }

  private async awaitDrained(name: QueueName, graceMs: number): Promise<void> {
    const active = this.inFlight.get(name);
    if (!active?.size) return;

    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        Promise.allSettled([...active]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
    } finally {
      // A leaked timer would keep the event loop alive past a clean shutdown.
      if (timer) clearTimeout(timer);
    }
  }
}
