import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { queueConfig, redisConfig } from '../../config';
import { QueuePublishError } from './queue-publish.error';
import {
  ALL_QUEUE_NAMES,
  buildQueueOptions,
  type QueueName,
} from './queue.config';

export type PublishOptions = {
  /**
   * BullMQ's queue-level deduplication key.
   *
   * A useful second line of defence and never the first one. BullMQ refuses a
   * job whose id already exists *in Redis*, so the guarantee lasts exactly as
   * long as retention keeps the job — once it is evicted, the same id is
   * accepted again. Durable idempotency therefore belongs to a PostgreSQL
   * UNIQUE constraint; this only collapses the duplicates that arrive close
   * together, which is precisely what a re-delivered outbox event produces.
   */
  jobId?: string;
};

export type PublishResult = {
  jobId: string;
};

/**
 * What the transport can say about one job, reduced to the three answers an
 * application needs.
 *
 * Deliberately not BullMQ's `JobState`. Every other state — `waiting`,
 * `active`, `delayed`, `prioritized`, `waiting-children`, `completed` — means
 * the same thing to a caller asking whether the transport has given up: it has
 * not, so do nothing. Collapsing them here keeps BullMQ's state vocabulary,
 * which changes between versions, out of application code.
 */
export type QueueJobTransportState =
  /** In the failed set: the transport is finished with this job. */
  | 'failed'
  /** Redis no longer holds it — retention removed it, or it never existed. */
  | 'missing'
  /** Still somewhere in the transport's own lifecycle. */
  | 'pending';

/**
 * Owns the BullMQ `Queue` instances and publishes to them.
 *
 * Lives only in processes that produce work. The API process deliberately does
 * not import the module that provides this: a `POST` handler writes the run and
 * its outbox event in one PostgreSQL transaction and returns, so the request
 * path holds no queue connection and a Redis outage cannot make it fail. The
 * dispatcher in the worker process is what turns those rows into jobs.
 */
@Injectable()
export class QueueProducer {
  private readonly queues = new Map<QueueName, Queue>();

  /**
   * How long a single publish may take.
   *
   * Not decoration. BullMQ resolves `add()` against a connection promise that
   * waits for `ready` and — by design, so a queue is never permanently poisoned
   * by one bad start — does not reject while the client is still reconnecting.
   * Without a bound here, one `add()` during a Redis outage would never settle,
   * the dispatcher's loop would stop advancing, and the outbox would stall
   * behind a single await. With it, the publish fails, control returns, and the
   * claimed event is re-delivered after its lease expires.
   */
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

  /**
   * Constructs every queue up front.
   *
   * Called by the worker entrypoint before the dispatcher starts, so BullMQ's
   * connection handshake and Lua script loading happen once, at a point where a
   * failure is a startup problem rather than a stalled publish. Not a
   * `OnModuleInit` hook: startup here has an order, and the entrypoint owns it.
   */
  init(): void {
    for (const name of ALL_QUEUE_NAMES) this.queueFor(name);
  }

  private queueFor(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;

    const created = new Queue(name, buildQueueOptions(this.redis, this.queue));

    /**
     * Required rather than tidy: BullMQ re-emits ioredis connection errors, and
     * an EventEmitter with no `error` listener throws. Without this, a Redis
     * blip would take the worker process down instead of delaying a publish.
     */
    created.on('error', (error: Error) => {
      this.logger.warn(
        { queue: name, err: { name: error.name, message: error.message } },
        'Queue connection error; publishing is degraded',
      );
    });

    this.queues.set(name, created);
    return created;
  }

  /**
   * Publishes one job, or throws `QueuePublishError`.
   *
   * Throwing is the contract. The caller is the outbox dispatcher, and its
   * correct response to a failed publish is to leave the event claimed so a
   * later pass retries it — which it can only do if it is told.
   */
  async publish(
    name: QueueName,
    jobName: string,
    data: unknown,
    options: PublishOptions = {},
  ): Promise<PublishResult> {
    const queue = this.queueFor(name);

    let timer: NodeJS.Timeout | undefined;

    try {
      const job = await Promise.race([
        queue.add(jobName, data, { jobId: options.jobId }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new QueuePublishError(
                  name,
                  'timeout',
                  `Publishing to "${name}" exceeded ${this.publishTimeoutMs}ms`,
                ),
              ),
            this.publishTimeoutMs,
          );
        }),
      ]);

      /**
       * Deliberately reports nothing about whether the job was new.
       *
       * BullMQ cannot tell us: its `addStandardJob` script returns the *same*
       * id for a duplicate as for an insert, publishing a `duplicated` event on
       * the queue's stream instead. Deriving an `accepted` flag from the return
       * value would therefore be a guess dressed as a fact — and the caller does
       * not need it, because both outcomes mean the same thing to the outbox:
       * the work is queued, so the event can be marked delivered.
       */
      return { jobId: job.id ?? options.jobId ?? '' };
    } catch (error) {
      if (error instanceof QueuePublishError) throw error;

      throw new QueuePublishError(
        name,
        'rejected',
        error instanceof Error ? error.message : String(error),
        error,
      );
    } finally {
      /**
       * Cleared on every path. A leaked timer would keep the event loop alive
       * and stop the process exiting after an otherwise clean shutdown.
       */
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Reports what the transport currently says about one job.
   *
   * A read on a producer, which is not a contradiction: this class owns the
   * `Queue` handles for the process, and BullMQ answers this from the ordinary
   * non-blocking connection those handles already hold. Giving the read its own
   * `Queue` would open a second Redis connection per queue to ask a question the
   * existing one can answer.
   *
   * Narrow on purpose. It returns no `failedReason`, no timestamps and no
   * attempt counts, because the only caller must not copy transport-authored
   * strings into durable business state, and because everything beyond these
   * three cases is a distinction the application does not act on.
   *
   * Errors are not swallowed. A Redis outage must look like an outage to the
   * caller, so it can retry on its next pass rather than mistake an unreachable
   * transport for a job that has gone away.
   */
  async jobTransportState(
    name: QueueName,
    jobId: string,
  ): Promise<QueueJobTransportState> {
    const state = await this.queueFor(name).getJobState(jobId);

    if (state === 'failed') return 'failed';

    // BullMQ's own word for "no such job", which is also what retention leaves
    // behind once it removes one.
    if (state === 'unknown') return 'missing';

    return 'pending';
  }

  /**
   * Closes every queue.
   *
   * Called explicitly by the shutdown sequence rather than through a lifecycle
   * hook, because the order matters: the dispatcher has to stop publishing
   * before its transport is taken away. Individual failures are swallowed —
   * a shutdown step that throws strands every step behind it, and a queue that
   * cannot be closed cleanly is being closed by process exit anyway.
   */
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
  }
}
