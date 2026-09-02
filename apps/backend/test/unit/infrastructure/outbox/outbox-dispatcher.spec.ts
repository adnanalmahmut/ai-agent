import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';

import {
  QueuePublishError,
  type QueueProducer,
} from '../../../../src/infrastructure/queue';
import { ROUTABLE_EVENT_TYPES } from '../../../../src/infrastructure/outbox/outbox-event.routes';
import { OutboxDispatcher } from '../../../../src/infrastructure/outbox/outbox-dispatcher.service';
import type {
  ClaimedOutboxEvent,
  ClaimOptions,
  OutboxClaim,
  OutboxRepository,
} from '../../../../src/infrastructure/outbox/outbox.repository';

/**
 * The delivery decisions, tested without a database or a Redis.
 *
 * Everything asserted here is a branch the dispatcher takes on its own — whether
 * a failed publish is retried or parked, how long it waits, what it does when it
 * discovers it no longer owns a claim. Those are the parts that go wrong
 * quietly: an event parked during an outage, or a stale writer overwriting a
 * delivered row, both look like a queue that is merely slow.
 *
 * What cannot be answered here is whether the *SQL* enforces ownership. That
 * needs a real PostgreSQL and two real claims, and lives in
 * `test/e2e/outbox.e2e-spec.ts`.
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
      warnAfterAttempts: 3,
    },
  };

  const claim =
    jest.fn<(options: ClaimOptions) => Promise<ClaimedOutboxEvent[]>>();
  const markDelivered = jest.fn<(ids: string[]) => Promise<void>>();
  const reschedule =
    jest.fn<
      (claim: OutboxClaim, delayMs: number, error: string) => Promise<boolean>
    >();
  const markFailed =
    jest.fn<(claim: OutboxClaim, error: string) => Promise<boolean>>();
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

  // Held as standalone spies so the assertions never pass an unbound method
  // around, and so they can be cleared between tests — several tests below
  // assert on the *absence* of a log line.
  const info = jest.fn();
  const warn = jest.fn();
  const error = jest.fn();
  const debug = jest.fn();
  const logger = { info, warn, error, debug } as unknown as PinoLogger;

  const event = (
    overrides: Partial<ClaimedOutboxEvent> = {},
  ): ClaimedOutboxEvent => ({
    id: 'evt-1',
    type: 'agent-run.queued',
    payload: { agentRunId: 'run-1' },
    dedupeKey: 'run-1',
    attempts: 1,
    claimedBy: 'host:1',
    ...overrides,
  });

  const transportFailure = () =>
    new QueuePublishError(
      'agent-execution',
      'timeout',
      'Publishing to "agent-execution" exceeded 2000ms',
    );

  let dispatcher: OutboxDispatcher;

  beforeEach(() => {
    claim.mockReset();
    markDelivered.mockReset().mockResolvedValue(undefined);
    reschedule.mockReset().mockResolvedValue(true);
    markFailed.mockReset().mockResolvedValue(true);
    publish.mockReset().mockResolvedValue({ jobId: 'run-1' });
    for (const spy of [info, warn, error, debug]) spy.mockClear();

    dispatcher = new OutboxDispatcher(repository, producer, config, logger);
  });

  it('claims nothing and does nothing on an empty outbox', async () => {
    claim.mockResolvedValue([]);

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
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

  /**
   * The rolling-deployment safeguard, at its source. A worker that asked for
   * every pending row would claim event types written by a newer API and could
   * then only park them.
   */
  it('claims only the event types this build can route', async () => {
    claim.mockResolvedValue([]);

    await dispatcher.dispatchOnce();

    // Derived from the route table rather than restated, so a newly routed
    // event type that the dispatcher forgets to claim fails here instead of
    // silently parking in production.
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({ types: [...ROUTABLE_EVENT_TYPES] }),
    );
    // Anchored, both of them: the assertion above compares the dispatcher to
    // the constant it already references, so it cannot notice a type dropped
    // from the route table. These can.
    expect(ROUTABLE_EVENT_TYPES).toContain('agent-run.queued');
    expect(ROUTABLE_EVENT_TYPES).toContain('knowledge-document.ingested');
  });

  describe('a transient publish failure', () => {
    beforeEach(() => {
      publish.mockRejectedValue(transportFailure());
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
        expect.objectContaining({ id: 'evt-1', attempts: 1 }),
        expect.any(Number),
        'Publishing to "agent-execution" exceeded 2000ms',
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
        expect.anything(),
        1_000,
        expect.any(String),
      );
    });

    it('doubles the delay as attempts accumulate', async () => {
      claim.mockResolvedValue([event({ attempts: 2 })]);
      await dispatcher.dispatchOnce();

      expect(reschedule).toHaveBeenLastCalledWith(
        expect.anything(),
        2_000,
        expect.any(String),
      );
    });

    /**
     * The cap matters more now that retries are unbounded: without it a long
     * outage would push the next attempt hours out, and the backlog would sit
     * still for hours after Redis came back.
     */
    it('caps the delay instead of growing without bound', async () => {
      claim.mockResolvedValue([event({ attempts: 40 })]);

      await dispatcher.dispatchOnce();

      expect(reschedule).toHaveBeenLastCalledWith(
        expect.anything(),
        60_000,
        expect.any(String),
      );
    });

    /**
     * The behaviour this iteration exists to fix.
     *
     * The API reports ready during a Redis outage precisely because accepted
     * work is durable in PostgreSQL. An attempt budget that parked events would
     * make that promise false the moment an outage outlasted it — and it is the
     * long outages, not the brief ones, where the promise matters.
     */
    it('never parks the event, however many attempts it has taken', async () => {
      for (const attempts of [3, 10, 11, 500, 10_000]) {
        reschedule.mockClear();
        markFailed.mockClear();
        claim.mockResolvedValue([event({ attempts })]);

        const pass = await dispatcher.dispatchOnce();

        expect(pass).toMatchObject({ deferred: 1, failed: 0 });
        expect(markFailed).not.toHaveBeenCalled();
        expect(reschedule).toHaveBeenCalled();
      }
    });

    /**
     * The renamed threshold changes the log level and nothing else. An operator
     * needs to see that an outage has stopped being momentary; the event needs
     * to keep being retried regardless.
     */
    it('escalates the log level past the warning threshold without changing the outcome', async () => {
      warn.mockClear();
      claim.mockResolvedValue([event({ attempts: 2 })]);
      await dispatcher.dispatchOnce();
      expect(warn).not.toHaveBeenCalled();

      warn.mockClear();
      claim.mockResolvedValue([event({ attempts: 3 })]);
      const pass = await dispatcher.dispatchOnce();

      expect(warn).toHaveBeenCalled();
      expect(pass).toMatchObject({ deferred: 1, failed: 0 });
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
        .mockRejectedValueOnce(transportFailure());

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ claimed: 2, delivered: 1, deferred: 1 });
      expect(markDelivered).toHaveBeenCalledWith(['evt-ok']);
      expect(reschedule).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'evt-bad' }),
        expect.any(Number),
        expect.any(String),
      );
    });
  });

  /**
   * The other half of the classification. A payload that cannot be serialised
   * fails identically on the thousandth attempt, so retrying it only hides it.
   */
  describe('a permanent publish failure', () => {
    it('parks an unserialisable payload immediately', async () => {
      claim.mockResolvedValue([event({ attempts: 1 })]);
      publish.mockRejectedValue(
        new QueuePublishError(
          'agent-execution',
          'rejected',
          'Converting circular structure to JSON',
        ),
      );

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ failed: 1, deferred: 0 });
      expect(markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'evt-1' }),
        'Converting circular structure to JSON',
      );
      expect(reschedule).not.toHaveBeenCalled();
    });

    it('parks a job that exceeds the configured size limit', async () => {
      claim.mockResolvedValue([event()]);
      publish.mockRejectedValue(
        new QueuePublishError(
          'agent-execution',
          'rejected',
          'The size of job execute exceeds the limit 1024 bytes',
        ),
      );

      await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
        failed: 1,
      });
    });

    /**
     * An unrecognised error is transient by default. Getting this backwards
     * destroys accepted work during an outage, so the ambiguous case has to fall
     * on the side that only costs a retry.
     */
    it('treats an unrecognised error as transient', async () => {
      claim.mockResolvedValue([event({ attempts: 99 })]);
      publish.mockRejectedValue(new Error('EPROTO something novel'));

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ deferred: 1, failed: 0 });
    });
  });

  /**
   * The stale-writer race, from the dispatcher's side: the repository reports
   * that the conditional update matched nothing, and the correct response is to
   * drop the event rather than retry or raise.
   */
  describe('when the claim has already been taken over', () => {
    it('treats a rejected reschedule as a harmless stale claim', async () => {
      claim.mockResolvedValue([event()]);
      publish.mockRejectedValue(transportFailure());
      reschedule.mockResolvedValue(false);

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ stale: 1, deferred: 0, failed: 0 });
      expect(error).not.toHaveBeenCalled();
    });

    it('treats a rejected park as a harmless stale claim', async () => {
      claim.mockResolvedValue([event()]);
      publish.mockRejectedValue(
        new QueuePublishError(
          'agent-execution',
          'rejected',
          'Converting circular structure to JSON',
        ),
      );
      markFailed.mockResolvedValue(false);

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ stale: 1, failed: 0 });
    });

    it('passes the whole claim, not just the id, so the write can be conditional', async () => {
      claim.mockResolvedValue([
        event({ id: 'evt-9', attempts: 4, claimedBy: 'host-b:22' }),
      ]);
      publish.mockRejectedValue(transportFailure());

      await dispatcher.dispatchOnce();

      expect(reschedule).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'evt-9',
          attempts: 4,
          claimedBy: 'host-b:22',
        }),
        expect.any(Number),
        expect.any(String),
      );
    });
  });

  /**
   * Unreachable while the claim filter and the route table agree, which is why
   * it is an error-level log. What matters is that it does not park the row:
   * this is the one branch where being wrong destroys work irreversibly.
   */
  it('releases rather than parks an event it cannot route', async () => {
    claim.mockResolvedValue([event({ type: 'agent-run.teleported' })]);

    const pass = await dispatcher.dispatchOnce();

    expect(pass).toMatchObject({ claimed: 1, deferred: 1, failed: 0 });
    expect(publish).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(reschedule).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
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
      await expect(dispatcher.stop(1_000)).resolves.toBeUndefined();
    });

    it('refuses to restart after stopping', async () => {
      claim.mockResolvedValue([]);

      await dispatcher.stop(1_000);
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
      await dispatcher.stop(1_000);

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

      const deadline = Date.now() + 2_000;
      while (!releasePublish && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const stopping = dispatcher.stop(5_000);
      expect(finished).toBe(false);

      releasePublish?.();
      await stopping;

      expect(finished).toBe(true);
      expect(markDelivered).toHaveBeenCalledWith(['evt-1']);
    });

    /**
     * The wait is bounded by what the caller passes, not by this component's own
     * grace period. A publish that never settles must not be able to consume the
     * whole process deadline and leave the BullMQ drain with none.
     */
    it('gives up on a publish that never settles, within the budget it was given', async () => {
      claim.mockResolvedValue([event()]);
      publish.mockImplementation(() => new Promise(() => undefined));

      dispatcher.start();
      await new Promise((resolve) => setTimeout(resolve, 120));

      const startedAt = Date.now();
      await dispatcher.stop(200);
      const waited = Date.now() - startedAt;

      expect(waited).toBeLessThan(1_500);
      expect(warn).toHaveBeenCalled();
    });

    /**
     * Protects the rest of the drain. Once shutdown has begun there is no reason
     * to keep publishing a batch claimed a moment ago — those rows are leased,
     * so leaving them is exactly what a crash would have done, and the time is
     * better spent letting the BullMQ workers finish.
     */
    it('abandons the rest of the batch once shutdown begins', async () => {
      claim.mockResolvedValue([
        event({ id: 'evt-1', dedupeKey: 'a' }),
        event({ id: 'evt-2', dedupeKey: 'b' }),
        event({ id: 'evt-3', dedupeKey: 'c' }),
      ]);

      let releaseFirst: (() => void) | undefined;
      publish.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return { jobId: 'a' };
      });

      const pass = dispatcher.dispatchOnce();

      const deadline = Date.now() + 2_000;
      while (!releaseFirst && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Shutdown starts while the first publish is still in flight.
      const stopping = dispatcher.stop(2_000);
      releaseFirst?.();

      const result = await pass;
      await stopping;

      expect(result).toMatchObject({
        claimed: 3,
        delivered: 1,
        abandoned: 2,
      });
      // The two abandoned events were never published and never mutated: they
      // stay PROCESSING under their lease.
      expect(publish).toHaveBeenCalledTimes(1);
      expect(markDelivered).toHaveBeenCalledWith(['evt-1']);
      expect(reschedule).not.toHaveBeenCalled();
      expect(markFailed).not.toHaveBeenCalled();
    });
  });
});
