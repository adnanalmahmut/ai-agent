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

/**
 * Runs the registered job handlers, and stops them on demand.
 *
 * One BullMQ `Worker` per queue that has at least one handler — not one per
 * handler. Each `Worker` owns a blocking Redis connection, so a worker per job
 * type would multiply idle connections for no gain, and BullMQ's concurrency
 * limit is per worker, which means per-handler workers would quietly multiply
 * the configured concurrency too.
 *
 * A process with no handlers creates nothing. That is what lets the API process
 * import the queue module for shutdown symmetry without becoming a consumer.
 */
@Injectable()
export class QueueWorkerRunner {
  private readonly workers = new Map<QueueName, Worker>();
  private readonly events = new Map<QueueName, QueueEvents>();

  /**
   * Handler promises currently in flight, per queue.
   *
   * Tracked here because BullMQ keeps the equivalent private, and the shutdown
   * sequence needs the answer: whether to close gracefully or force. Reading it
   * from the queue in Redis would be worse than useless — a job left active by
   * *another* worker would look like our own.
   */
  private readonly inFlight = new Map<QueueName, Set<Promise<void>>>();

  /** queue → job name → handler. Built once; ambiguity is a startup error. */
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
        /**
         * Thrown at construction, so two handlers claiming the same job name
         * stop the process from starting. Resolved at runtime it would mean one
         * of them silently never runs, which is indistinguishable from a queue
         * that is merely quiet.
         */
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

  /**
   * Starts consuming.
   *
   * Deliberately explicit rather than an `OnModuleInit` hook: `autorun` is off
   * in the worker options precisely so nothing claims a job before the process
   * has finished wiring its dispatcher and its readiness state, and a lifecycle
   * hook would hand that ordering back to the framework.
   */
  start(): void {
    for (const [name, routes] of this.routes) {
      const worker = new Worker(
        name,
        (job: Job) => this.dispatch(name, routes, job),
        buildWorkerOptions(this.redis, this.queue),
      );

      /**
       * Required, not diagnostic: BullMQ re-emits ioredis connection errors and
       * an unhandled `error` event throws. A worker whose Redis blinked must
       * reconnect, not crash the process.
       */
      worker.on('error', (error: Error) => {
        this.logger.warn(
          { queue: name, err: { name: error.name, message: error.message } },
          'Worker connection error',
        );
      });

      /**
       * A stalled job is the recovery mechanism working, not a defect: it is
       * what happens after a worker is killed mid-job, and it is why a
       * deployment shutdown does not have to mark anything failed. Logged at
       * warn because a *rising* stall rate does mean something is wrong.
       */
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

  /**
   * Queue-level failure telemetry.
   *
   * A separate connection from the worker's, which is BullMQ's design: the
   * events stream is read with its own blocking client. Worth its cost because
   * these are the only two signals visible when a *worker* dies rather than a
   * job — a process that vanished logs nothing itself.
   */
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
      /**
       * `UnrecoverableError` rather than a plain throw. An unrecognised job name
       * will not become recognised on the third attempt, so retrying it three
       * times only delays the diagnosis and burns queue capacity — the failure
       * belongs in the failed set immediately, where it is visible.
       */
      throw new UnrecoverableError(
        `No handler for job "${job.name}" on queue "${name}"`,
      );
    }

    const active = this.inFlight.get(name) ?? new Set<Promise<void>>();
    this.inFlight.set(name, active);

    const work = handler.handle(job as Job<never>);
    active.add(work);

    /**
     * Returned rather than awaited so the rejection still reaches BullMQ — a
     * swallowed error here would mark a failed job completed. `finally` also
     * counts as handling `work`, so tracking it cannot produce an unhandled
     * rejection.
     */
    return work.finally(() => active.delete(work));
  }

  /**
   * Stops consuming, draining what is already in flight within `maxDrainMs`.
   *
   * Nothing here touches business state, and that is the point. A job abandoned
   * at the end of the grace period keeps its durable record and is recovered as
   * stalled by another worker — so a deployment is never mistaken for a
   * cancellation. Writing `RUNNING` → `CANCELLED` on `SIGTERM` would lose that
   * distinction permanently: `CANCELLED` has to mean somebody decided the work
   * should not happen.
   *
   * `QueueEvents` closes after the workers, so the events stream is still being
   * read while the last jobs finish and their failures are still recorded.
   */
  async stop(maxDrainMs = this.queue.shutdownGraceMs): Promise<void> {
    /**
     * The caller's bound wins when it is tighter. `QUEUE_SHUTDOWN_GRACE_MS` is
     * this component's *maximum*, not its entitlement — the worker entrypoint
     * passes what is left of the one process-wide deadline, so the drain cannot
     * consume time the closing steps still need. The default keeps the method
     * usable on its own, which the tests rely on.
     */
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

  /**
   * Stops one worker: no new claims, then a bounded drain, then one close.
   *
   * The three steps are separate because BullMQ makes them separate. In
   * particular `close(force)` cannot be escalated: `Worker.close` caches its
   * first promise and returns it to every later caller, so an optimistic
   * `close()` followed by a `close(true)` when the grace period expires does
   * nothing at all — the second call simply awaits the first, and the process
   * hangs until the job finishes on its own. The decision has to be made before
   * the single call, which is why the in-flight count is tracked in this class.
   */
  private async closeWorker(
    name: QueueName,
    worker: Worker,
    graceMs: number,
  ): Promise<void> {
    try {
      /**
       * `doNotWaitActive`, so this returns at once. It is the step that
       * satisfies "claims no new job" — and it has to happen before the drain,
       * or the worker would keep fetching throughout the grace period and never
       * become idle.
       */
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

  /**
   * Waits for the handlers already running to finish, for at most `graceMs`.
   *
   * The bound exists because the orchestrator has one too: a process that
   * overruns its termination grace period is `SIGKILL`ed mid-write, which is
   * strictly worse than abandoning a job that BullMQ will hand to another
   * worker. `allSettled`, not `all` — a failing job is finished for the purposes
   * of shutting down.
   */
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
