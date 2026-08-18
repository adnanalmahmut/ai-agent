import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { hostname } from 'node:os';
import { PinoLogger } from 'nestjs-pino';

import { queueConfig } from '../../config';
import { QueueProducer } from '../queue';
import {
  OUTBOX_EVENT_ROUTES,
  isRoutableEventType,
} from './outbox-event.routes';
import type { ClaimedOutboxEvent } from './outbox.repository';
import { OutboxRepository } from './outbox.repository';

/** What one pass did, so the caller and the tests can assert on it. */
export type DispatchPass = {
  claimed: number;
  delivered: number;
  /** Publishing failed; the event was handed back for a later pass. */
  deferred: number;
  /** Parked: the attempt budget is spent, or the type has no route. */
  failed: number;
};

/** Ceiling on the retry delay, so a long outage does not push it to hours. */
const MAX_BACKOFF_MS = 60_000;

/**
 * Turns committed outbox rows into queue jobs.
 *
 * Lives in the worker process, not the API. The API's job ends when its
 * transaction commits — that is what makes accepting a run a single atomic write
 * — and giving the request path a queue connection would reintroduce exactly the
 * failure the outbox exists to remove.
 *
 * The delivery sequence, and why each step is where it is:
 *
 *   1. One statement claims a batch and leases it, then commits. No database
 *      lock is held across the Redis call that follows; holding one there would
 *      turn a queue outage into a database incident.
 *   2. `queue.add()` publishes.
 *   3. A second statement records `DELIVERED`.
 *
 * A crash between 2 and 3 is the interesting case, and it is *designed for*
 * rather than prevented: the row stays `PROCESSING`, its lease expires, another
 * dispatcher reclaims it, and the job is published again. That is why delivery
 * is at-least-once and every consumer must be safe to run twice — a guarantee
 * bought cheaply here, as against the alternative of a distributed transaction.
 */
@Injectable()
export class OutboxDispatcher {
  /**
   * Identifies this dispatcher in `claimedBy`.
   *
   * Audit only. Ownership is decided by the lease, which does not depend on a
   * process reporting its own identity accurately.
   */
  private readonly identity = `${hostname()}:${process.pid}`;

  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  /**
   * The pass currently running, if any.
   *
   * Held so `stop()` can wait for it. Without this the shutdown sequence could
   * close the queue while a publish was in flight, which would produce a failed
   * delivery — and therefore a duplicate on the next pass — for no reason other
   * than the order in which two things were closed.
   */
  private inFlight: Promise<DispatchPass> | undefined;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly producer: QueueProducer,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Begins polling.
   *
   * Re-armed after each pass rather than run on an interval: `setInterval` would
   * start a second pass while the first was still waiting on Redis, and two
   * concurrent passes in one process claim each other's leases for no benefit.
   */
  start(): void {
    if (this.timer || this.stopping) return;

    this.logger.info(
      {
        pollIntervalMs: this.config.outbox.pollIntervalMs,
        batchSize: this.config.outbox.batchSize,
        leaseMs: this.config.outbox.leaseMs,
      },
      'Outbox dispatcher started',
    );

    this.scheduleNext(0);
  }

  /**
   * Stops polling and waits for the pass in progress.
   *
   * First in the worker's shutdown sequence, and it has to be: everything after
   * it takes away something this depends on. Awaiting the in-flight pass is what
   * makes the rest of the sequence safe rather than merely ordered.
   */
  async stop(): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    try {
      await this.inFlight;
    } catch {
      // A pass that failed on its way out has already logged; the shutdown
      // sequence must continue regardless.
    }

    this.logger.info('Outbox dispatcher stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;

      const pass = this.dispatchOnce();
      this.inFlight = pass;

      void pass
        .catch((error: unknown) => {
          /**
           * Reached when the *claim* fails — PostgreSQL is unreachable, or the
           * statement was rejected. Publishing failures are handled per event
           * inside the pass and never arrive here.
           */
          this.logger.error(
            { err: error instanceof Error ? { message: error.message } : {} },
            'Outbox dispatch pass failed',
          );
        })
        .finally(() => {
          this.inFlight = undefined;
          this.scheduleNext(this.config.outbox.pollIntervalMs);
        });
    }, delayMs);
  }

  /**
   * One claim-publish-record cycle.
   *
   * Public because it is the honest unit of this class: a test can run exactly
   * one pass and assert what it did, without a timer deciding when that happens.
   */
  async dispatchOnce(): Promise<DispatchPass> {
    const { batchSize, leaseMs } = this.config.outbox;

    const claimed = await this.repository.claim(
      batchSize,
      leaseMs,
      this.identity,
    );

    const pass: DispatchPass = {
      claimed: claimed.length,
      delivered: 0,
      deferred: 0,
      failed: 0,
    };

    if (claimed.length === 0) return pass;

    const delivered: string[] = [];

    /**
     * Sequential, not `Promise.all`.
     *
     * A batch is published one event at a time so that a Redis that has started
     * refusing writes costs one timeout rather than `batchSize` of them, and so
     * the events that did get through are recorded rather than lost among the
     * ones that did not. Throughput is bounded by the poll interval and the batch
     * size, not by this loop.
     */
    for (const event of claimed) {
      const outcome = await this.deliver(event);

      if (outcome === 'delivered') {
        delivered.push(event.id);
        pass.delivered += 1;
      } else {
        pass[outcome] += 1;
      }
    }

    await this.repository.markDelivered(delivered);

    return pass;
  }

  private async deliver(
    event: ClaimedOutboxEvent,
  ): Promise<'delivered' | 'deferred' | 'failed'> {
    if (!isRoutableEventType(event.type)) {
      /**
       * Unroutable now and unroutable on every future pass, so it is parked
       * rather than retried. In practice this means an event written by an API
       * newer than the worker beside it — a deployment ordering mistake that
       * should be visible in the table rather than hidden in a retry loop.
       */
      await this.repository.markFailed(
        event.id,
        `No route registered for event type "${event.type}"`,
      );
      this.logger.error(
        { eventId: event.id, type: event.type },
        'Outbox event has no route and was parked',
      );

      return 'failed';
    }

    const route = OUTBOX_EVENT_ROUTES[event.type];

    try {
      const { jobId } = await this.producer.publish(
        route.queue,
        route.jobName,
        event.payload,
        { jobId: event.dedupeKey ?? undefined },
      );

      this.logger.debug(
        { eventId: event.id, type: event.type, queue: route.queue, jobId },
        'Outbox event published',
      );

      return 'delivered';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      if (event.attempts >= this.config.outbox.maxAttempts) {
        await this.repository.markFailed(event.id, reason);
        this.logger.error(
          { eventId: event.id, type: event.type, attempts: event.attempts },
          'Outbox event exhausted its attempts and was parked',
        );

        return 'failed';
      }

      await this.repository.reschedule(
        event.id,
        this.backoffFor(event.attempts),
        reason,
      );
      this.logger.warn(
        { eventId: event.id, type: event.type, attempts: event.attempts },
        'Outbox event publication failed and was rescheduled',
      );

      return 'deferred';
    }
  }

  /**
   * Exponential, capped.
   *
   * `attempts` has already been incremented by the claim, so the first failure
   * has `attempts === 1` and waits one base delay rather than none — a retry that
   * fires immediately against a Redis that just refused a write is not a retry,
   * it is a second failure.
   */
  private backoffFor(attempts: number): number {
    const exponent = Math.min(Math.max(attempts - 1, 0), 20);

    return Math.min(this.config.job.backoffMs * 2 ** exponent, MAX_BACKOFF_MS);
  }
}
