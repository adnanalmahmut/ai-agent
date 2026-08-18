import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';

import { QueuePublishError, type QueueProducer } from '../queue';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import type { ClaimedOutboxEvent, OutboxRepository } from './outbox.repository';

/**
 * The delivery decisions, tested without a database or a Redis.
 *
 * Everything asserted here is a branch the dispatcher takes on its own —
 * whether a failed publish is retried or parked, how long it waits, what the
 * attempt counter means. Those are the parts that go wrong quietly: an event
 * retried forever, or one parked on its first hiccup, both look like a queue
 * that is merely slow.
 *
 * The SQL that makes the claim safe under concurrency is a different question
 * and cannot be answered here — `FOR UPDATE SKIP LOCKED` needs a real
 * PostgreSQL and two real dispatchers, which is what `test/outbox.e2e-spec.ts`
 * provides.
 */
describe('OutboxDispatcher', () => {
  const config = {
    prefix: 'bmq',
    workerConcurrency: 4,
    shutdownGraceMs: 25_000,
    job: { attempts: 3, backoffMs: 1_000 },
    retention: {
      completed: { ageSeconds: 3_600, count: 1_000 },
      failed: { ageSeconds: 604_800, count: 5_000 },
    },
    outbox: {
      pollIntervalMs: 50,
      batchSize: 10,
      leaseMs: 30_000,
      maxAttempts: 3,
    },
  };

  const claim =
    jest.fn<
      (
        limit: number,
        leaseMs: number,
        claimedBy: string,
      ) => Promise<ClaimedOutboxEvent[]>
    >();
  const markDelivered = jest.fn<(ids: string[]) => Promise<void>>();
  const reschedule =
    jest.fn<(id: string, delayMs: number, error: string) => Promise<void>>();
  const markFailed = jest.fn<(id: string, error: string) => Promise<void>>();
  const publish =
    jest.fn<
      (
        queue: string,
        jobName: string,
        payload: unknown,
        options?: { jobId?: string },
      ) => Promise<{ jobId: string }>
    >();

  const repository = {
    claim,
    markDelivered,
    reschedule,
    markFailed,
  } as unknown as OutboxRepository;

  const producer = { publish } as unknown as QueueProducer;

  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as PinoLogger;

  const event = (
    overrides: Partial<ClaimedOutboxEvent> = {},
  ): ClaimedOutboxEvent => ({
    id: 'evt-1',
    type: 'agent-run.queued',
    payload: { agentRunId: 'run-1' },
    dedupeKey: 'run-1',
    attempts: 1,
    ...overrides,
  });

  let dispatcher: OutboxDispatcher;

  beforeEach(() => {
    claim.mockReset();
    markDelivered.mockReset().mockResolvedValue(undefined);
    reschedule.mockReset().mockResolvedValue(undefined);
    markFailed.mockReset().mockResolvedValue(undefined);
    publish.mockReset().mockResolvedValue({ jobId: 'run-1' });

    dispatcher = new OutboxDispatcher(repository, producer, config, logger);
  });

  it('claims nothing and does nothing on an empty outbox', async () => {
    claim.mockResolvedValue([]);

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({
      claimed: 0,
      delivered: 0,
      deferred: 0,
      failed: 0,
    });

    expect(publish).not.toHaveBeenCalled();
    // Not `markDelivered([])`: an empty write is a round trip that buys nothing.
    expect(markDelivered).not.toHaveBeenCalled();
  });

  it('publishes a claimed event to its routed queue and job name', async () => {
    claim.mockResolvedValue([event()]);

    const pass = await dispatcher.dispatchOnce();

    expect(pass).toMatchObject({ claimed: 1, delivered: 1 });
    expect(publish).toHaveBeenCalledWith(
      'agent-execution',
      'execute',
      { agentRunId: 'run-1' },
      { jobId: 'run-1' },
    );
    expect(markDelivered).toHaveBeenCalledWith(['evt-1']);
  });

  /**
   * The ordering that makes the crash window recoverable rather than lossy. If
   * `DELIVERED` were written first, a crash before publishing would lose the
   * work with no trace; written second, a crash after publishing merely produces
   * a duplicate — which every consumer is already required to tolerate.
   */
  it('records delivery only after publishing', async () => {
    claim.mockResolvedValue([event()]);

    const order: string[] = [];
    publish.mockImplementation(() => {
      order.push('publish');
      return Promise.resolve({ jobId: 'run-1' });
    });
    markDelivered.mockImplementation(() => {
      order.push('markDelivered');
      return Promise.resolve();
    });

    await dispatcher.dispatchOnce();

    expect(order).toEqual(['publish', 'markDelivered']);
  });

  it('carries the deduplication key through as the job id', async () => {
    claim.mockResolvedValue([event({ dedupeKey: null })]);

    await dispatcher.dispatchOnce();

    // `undefined`, not `null`: BullMQ treats a null id as a value to use.
    expect(publish).toHaveBeenCalledWith(
      'agent-execution',
      'execute',
      expect.anything(),
      { jobId: undefined },
    );
  });

  describe('a publish that fails', () => {
    beforeEach(() => {
      publish.mockRejectedValue(
        new QueuePublishError(
          'agent-execution',
          'timeout',
          'Publishing exceeded 2000ms',
        ),
      );
    });

    /**
     * The single most important behaviour in this class. A failed publish must
     * leave the event *undelivered*, because the alternative — swallowing the
     * error and marking it delivered — converts at-least-once into at-most-once
     * and loses the run silently.
     */
    it('hands the event back rather than marking it delivered', async () => {
      claim.mockResolvedValue([event()]);

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ claimed: 1, delivered: 0, deferred: 1 });
      expect(markDelivered).toHaveBeenCalledWith([]);
      expect(reschedule).toHaveBeenCalledWith(
        'evt-1',
        expect.any(Number),
        'Publishing exceeded 2000ms',
      );
    });

    /**
     * `attempts` is already incremented by the claim, so a first failure waits
     * one base delay rather than none. Retrying immediately against a Redis that
     * has just refused a write is not a retry, it is a second failure.
     */
    it('waits one base delay on the first failure', async () => {
      claim.mockResolvedValue([event({ attempts: 1 })]);

      await dispatcher.dispatchOnce();

      expect(reschedule).toHaveBeenCalledWith(
        'evt-1',
        1_000,
        expect.any(String),
      );
    });

    it('doubles the delay as attempts accumulate', async () => {
      claim.mockResolvedValue([event({ attempts: 2 })]);
      await dispatcher.dispatchOnce();

      expect(reschedule).toHaveBeenLastCalledWith(
        'evt-1',
        2_000,
        expect.any(String),
      );
    });

    /**
     * Capped, so a long outage cannot push the next attempt hours out and leave
     * the queue idle after Redis comes back.
     */
    it('caps the delay instead of growing without bound', async () => {
      claim.mockResolvedValue([event({ attempts: 2, id: 'evt-huge' })]);
      // Base delay large enough that doubling would exceed the ceiling.
      const wide = new OutboxDispatcher(
        repository,
        producer,
        { ...config, job: { attempts: 3, backoffMs: 50_000 } },
        logger,
      );

      await wide.dispatchOnce();

      expect(reschedule).toHaveBeenLastCalledWith(
        'evt-huge',
        60_000,
        expect.any(String),
      );
    });

    /**
     * Parked rather than retried in perpetuity. An event that has failed its
     * whole budget is rarely a transient fault, and a poison event retried
     * forever starves every event behind it.
     */
    it('parks the event once its attempt budget is spent', async () => {
      claim.mockResolvedValue([event({ attempts: 3 })]);

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ deferred: 0, failed: 1 });
      expect(markFailed).toHaveBeenCalledWith(
        'evt-1',
        'Publishing exceeded 2000ms',
      );
      expect(reschedule).not.toHaveBeenCalled();
    });

    /**
     * One event's failure must not strand the rest of the batch. The events that
     * did reach the queue have to be recorded, or the next pass republishes them.
     */
    it('still records the events in the batch that did publish', async () => {
      claim.mockResolvedValue([
        event({ id: 'evt-ok', dedupeKey: 'ok' }),
        event({ id: 'evt-bad', dedupeKey: 'bad' }),
      ]);
      publish
        .mockResolvedValueOnce({ jobId: 'ok' })
        .mockRejectedValueOnce(
          new QueuePublishError('agent-execution', 'timeout', 'nope'),
        );

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ claimed: 2, delivered: 1, deferred: 1 });
      expect(markDelivered).toHaveBeenCalledWith(['evt-ok']);
      expect(reschedule).toHaveBeenCalledWith(
        'evt-bad',
        expect.any(Number),
        'nope',
      );
    });
  });

  /**
   * An unrecognised type will not become recognised on the next pass, so
   * retrying it only delays the diagnosis. In practice this is an event written
   * by an API newer than the worker running beside it — a deployment ordering
   * mistake that belongs in the table where somebody can see it.
   */
  it('parks an event whose type has no route, without publishing', async () => {
    claim.mockResolvedValue([event({ type: 'agent-run.teleported' })]);

    const pass = await dispatcher.dispatchOnce();

    expect(pass).toMatchObject({ claimed: 1, failed: 1 });
    expect(publish).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      'evt-1',
      'No route registered for event type "agent-run.teleported"',
    );
  });

  /**
   * A claim failure is PostgreSQL being unreachable, and there is nothing
   * sensible to do about it inside the pass. It propagates so the polling loop
   * logs it once and tries again; swallowing it here would make an unreachable
   * database look like an empty outbox.
   */
  it('propagates a failure to claim', async () => {
    claim.mockRejectedValue(new Error('terminating connection'));

    await expect(dispatcher.dispatchOnce()).rejects.toThrow(
      'terminating connection',
    );
    expect(publish).not.toHaveBeenCalled();
  });

  describe('lifecycle', () => {
    it('stops cleanly when it was never started', async () => {
      await expect(dispatcher.stop()).resolves.toBeUndefined();
    });

    it('refuses to restart after stopping', async () => {
      claim.mockResolvedValue([]);

      await dispatcher.stop();
      dispatcher.start();

      // Nothing scheduled, so nothing is ever claimed. A dispatcher restarted
      // during shutdown would publish while the queue was being closed.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(claim).not.toHaveBeenCalled();
    });

    it('polls until stopped, then leaves the loop idle', async () => {
      claim.mockResolvedValue([]);

      dispatcher.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await dispatcher.stop();

      const passesWhileRunning = claim.mock.calls.length;
      expect(passesWhileRunning).toBeGreaterThan(0);

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(claim.mock.calls.length).toBe(passesWhileRunning);
    });

    /**
     * The reason `stop()` is first in the worker's shutdown sequence rather than
     * merely early in it. If it returned while a publish was in flight, the next
     * step — closing the queue — would fail that publish, and the event would be
     * duplicated on the next pass for no reason but the order things closed in.
     */
    it('waits for the pass in progress before returning', async () => {
      let releasePublish: (() => void) | undefined;
      let finished = false;

      claim.mockResolvedValue([event()]);
      publish.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releasePublish = resolve;
        });
        finished = true;
        return { jobId: 'run-1' };
      });

      dispatcher.start();

      // Wait until the publish is actually in flight.
      const deadline = Date.now() + 2_000;
      while (!releasePublish && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const stopping = dispatcher.stop();
      expect(finished).toBe(false);

      releasePublish?.();
      await stopping;

      expect(finished).toBe(true);
      expect(markDelivered).toHaveBeenCalledWith(['evt-1']);
    });
  });
});
