import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { hostname } from 'node:os';
import { PinoLogger } from 'nestjs-pino';

import { queueConfig } from '../../config';
import { QueueProducer, classifyPublishError } from '../queue';
import {
  OUTBOX_EVENT_ROUTES,
  ROUTABLE_EVENT_TYPES,
  isRoutableEventType,
} from './outbox-event.routes';
import type { ClaimedOutboxEvent } from './outbox.repository';
import { OutboxRepository } from './outbox.repository';

/** What one pass did, so the caller and the tests can assert on it. */
export type DispatchPass = {
  claimed: number;
  delivered: number;
  /** Publishing failed transiently; the event was handed back for a later pass. */
  deferred: number;
  /** Parked: the failure is deterministic and retrying cannot fix it. */
  failed: number;
  /**
   * Claimed but never attempted, because shutdown began mid-batch. The rows stay
   * `PROCESSING` and are reclaimed when their leases expire.
   */
  abandoned: number;
  /**
   * The dispatcher no longer owned the claim when it went to record an outcome.
   * A normal race, not an error — see `OutboxClaim`.
   */
  stale: number;
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
 *
 * Two things this deliberately does *not* do:
 *
 * - It never gives up on a transport failure. There is no attempt budget that
 *   parks an event because Redis was down for a while; see `deliver`.
 * - It never claims an event type it cannot route, so an older worker cannot
 *   destroy work written by a newer API during a rollout.
 */
@Injectable()
export class OutboxDispatcher {
  /**
   * Identifies this dispatcher, and — with `attempts` — versions its claims.
   *
   * Not merely an audit field. `(claimedBy, attempts)` is what a conditional
   * `reschedule` or `markFailed` matches on, so a dispatcher whose lease lapsed
   * cannot overwrite the outcome recorded by whoever reclaimed the row.
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
        routableTypes: ROUTABLE_EVENT_TYPES,
      },
      'Outbox dispatcher started',
    );

    this.scheduleNext(0);
  }

  /**
   * Stops polling and gives the pass in progress a bounded chance to settle.
   *
   * First in the worker's shutdown sequence, and it has to be: everything after
   * it takes away something this depends on. Waiting for the in-flight pass is
   * what makes the rest of the sequence safe rather than merely ordered — the
   * queue is not closed underneath a publish that is still running.
   *
   * `maxWaitMs` comes from the process-wide shutdown budget, not from this
   * component's own idea of a grace period. Every component having its own full
   * grace is how a worker ends up promising more time than the process has. The
   * default is this component's ceiling, which keeps the method usable on its
   * own; the worker entrypoint always passes the tighter figure.
   *
   * Giving up is safe by construction: the events are claimed under a lease, so
   * abandoning them mid-pass leaves exactly the state a crash would, and another
   * dispatcher reclaims them once the lease expires.
   */
  async stop(maxWaitMs = this.config.shutdownGraceMs): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const pass = this.inFlight;

    if (pass) {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      try {
        await Promise.race([
          pass.then(
            () => {
              settled = true;
            },
            () => {
              // A pass that failed on its way out has already logged. It still
              // counts as settled: nothing of ours is left running.
              settled = true;
            },
          ),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(maxWaitMs, 0));
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (!settled) {
        this.logger.warn(
          { maxWaitMs },
          'Outbox pass did not settle within the remaining shutdown budget; ' +
            'its events stay claimed and are reclaimed when their lease expires',
        );
      }
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

    const claimed = await this.repository.claim({
      limit: batchSize,
      leaseMs,
      claimedBy: this.identity,
      /**
       * Only what this build can route. An older worker running beside a newer
       * API must leave that API's unfamiliar event types alone rather than claim
       * and park them — the work would be destroyed before the newer worker
       * started.
       */
      types: ROUTABLE_EVENT_TYPES,
    });

    const pass: DispatchPass = {
      claimed: claimed.length,
      delivered: 0,
      deferred: 0,
      failed: 0,
      abandoned: 0,
      stale: 0,
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
    for (const [index, event] of claimed.entries()) {
      /**
       * Shutdown began part-way through the batch. The remaining events are left
       * exactly as a crash would leave them — `PROCESSING`, under a lease that
       * expires — rather than publishing on into a queue that is about to close
       * and spending drain budget the BullMQ workers need.
       */
      if (this.stopping) {
        pass.abandoned = claimed.length - index;
        this.logger.info(
          { abandoned: pass.abandoned },
          'Shutdown began mid-batch; remaining claimed events left for reclaim',
        );
        break;
      }

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
  ): Promise<'delivered' | 'deferred' | 'failed' | 'stale'> {
    if (!isRoutableEventType(event.type)) {
      /**
       * Unreachable in normal operation: the claim filters on
       * `ROUTABLE_EVENT_TYPES`, so an unknown type is never handed to this
       * process in the first place.
       *
       * If it happens anyway the row is *released*, not parked. Marking it
       * `FAILED` would destroy work that a newer worker could have performed
       * perfectly well, and this branch is the one place where being wrong is
       * irreversible. The mismatch is logged as an invariant violation because
       * it means the claim filter and the route table have diverged.
       */
      this.logger.error(
        { eventId: event.id, type: event.type, routable: ROUTABLE_EVENT_TYPES },
        'Claimed an event this worker cannot route; releasing it unchanged. ' +
          'The claim filter and the route table disagree.',
      );

      return this.release(event, this.backoffFor(event.attempts), {
        reason: `Claimed by a worker with no route for "${event.type}"`,
      });
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

      /**
       * The decision that keeps durably accepted work alive.
       *
       * A transport failure says nothing about the event, so it is retried for
       * as long as it takes — there is no attempt count at which a Redis outage
       * becomes the event's fault. Only a deterministically impossible publish
       * is terminal.
       */
      if (classifyPublishError(error) === 'permanent') {
        const parked = await this.repository.markFailed(event, reason);

        this.logger[parked ? 'error' : 'debug'](
          { eventId: event.id, type: event.type, attempts: event.attempts },
          parked
            ? 'Outbox event can never be published and was parked'
            : 'Stale claim; another dispatcher already owns this event',
        );

        return parked ? 'failed' : 'stale';
      }

      return this.release(event, this.backoffFor(event.attempts), { reason });
    }
  }

  /**
   * Hands an event back for a later pass, if this dispatcher still owns it.
   *
   * A `false` from the repository means the lease lapsed and somebody else has
   * since recorded an outcome — very often `DELIVERED`, by the dispatcher that
   * reclaimed it. Overwriting that is the bug this guard exists for, so a stale
   * result is counted and dropped rather than retried or raised.
   */
  private async release(
    event: ClaimedOutboxEvent,
    delayMs: number,
    { reason }: { reason: string },
  ): Promise<'deferred' | 'stale'> {
    const rescheduled = await this.repository.reschedule(
      event,
      delayMs,
      reason,
    );

    if (!rescheduled) {
      this.logger.debug(
        { eventId: event.id, type: event.type, attempts: event.attempts },
        'Stale claim; another dispatcher already owns this event',
      );

      return 'stale';
    }

    /**
     * Escalates from `debug` once the retries stop looking momentary. The
     * threshold decides only how loudly this is reported — never whether the
     * event is still retried.
     */
    const persistent = event.attempts >= this.config.outbox.warnAfterAttempts;

    this.logger[persistent ? 'warn' : 'debug'](
      {
        eventId: event.id,
        type: event.type,
        attempts: event.attempts,
        retryInMs: delayMs,
        reason,
      },
      persistent
        ? 'Outbox event still undelivered after repeated attempts; the queue ' +
            'transport looks unhealthy. It remains queued and will keep retrying.'
        : 'Outbox event publication failed and was rescheduled',
    );

    return 'deferred';
  }

  /**
   * Exponential, capped.
   *
   * `attempts` has already been incremented by the claim, so the first failure
   * has `attempts === 1` and waits one base delay rather than none — a retry that
   * fires immediately against a Redis that just refused a write is not a retry,
   * it is a second failure.
   *
   * The cap matters more now that retries are unbounded: without it a long
   * outage would push the next attempt hours out, and the backlog would sit
   * still for hours after Redis came back.
   */
  private backoffFor(attempts: number): number {
    const exponent = Math.min(Math.max(attempts - 1, 0), 20);

    return Math.min(this.config.job.backoffMs * 2 ** exponent, MAX_BACKOFF_MS);
  }
}
