import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { hostname } from 'node:os';

import { queueConfig } from '../config';
import { QueueProducer, classifyPublishError } from '../queue';
import {
  OUTBOX_EVENT_ROUTES,
  ROUTABLE_EVENT_TYPES,
  isRoutableEventType,
} from './outbox-event.routes';
import type { ClaimedOutboxEvent } from './outbox.repository';
import { OutboxRepository } from './outbox.repository';

export type DispatchPass = {
  claimed: number;
  delivered: number;
  deferred: number;
  failed: number;
  abandoned: number;
  stale: number;
};

const MAX_BACKOFF_MS = 60_000;

@Injectable()
export class OutboxDispatcher {
  private readonly identity = `${hostname()}:${process.pid}`;

  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  private inFlight: Promise<DispatchPass> | undefined;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly producer: QueueProducer,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
    private readonly logger: PinoLogger,
  ) {}

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

  async dispatchOnce(): Promise<DispatchPass> {
    const { batchSize, leaseMs } = this.config.outbox;

    const claimed = await this.repository.claim({
      limit: batchSize,
      leaseMs,
      claimedBy: this.identity,
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

    for (const [index, event] of claimed.entries()) {
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

  private backoffFor(attempts: number): number {
    const exponent = Math.min(Math.max(attempts - 1, 0), 20);

    return Math.min(this.config.job.backoffMs * 2 ** exponent, MAX_BACKOFF_MS);
  }
}
