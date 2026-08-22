/**
 * The worker's real startup sequence, run against doubles.
 *
 * `worker.ts` calls `bootstrap()` on import, so before this sequence was
 * extracted nothing could exercise it — only a copy, which keeps passing after
 * the real one changes. The failure mode this file exists for is silent by
 * construction: a background loop that is never started produces no error, no
 * log line and no failing assertion anywhere else, just work that quietly never
 * happens.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { startWorkerRuntime } from '../../worker.runtime';

function harness() {
  // A single shared array rather than four independent spies, because the
  // property under test is the relative order and not merely that each was
  // called.
  const order: string[] = [];
  const record = (step: string) => () => {
    order.push(step);
  };

  const deps = {
    producer: { init: jest.fn<() => void>(record('producer.init')) },
    runner: { start: jest.fn<() => void>(record('runner.start')) },
    dispatcher: { start: jest.fn<() => void>(record('dispatcher.start')) },
    reconciler: { start: jest.fn<() => void>(record('reconciler.start')) },
  };

  return { deps, order };
}

describe('startWorkerRuntime', () => {
  let context: ReturnType<typeof harness>;

  beforeEach(() => {
    context = harness();
  });

  it('starts every loop the worker process owns', () => {
    startWorkerRuntime(context.deps);

    expect(context.deps.producer.init).toHaveBeenCalledTimes(1);
    expect(context.deps.runner.start).toHaveBeenCalledTimes(1);
    expect(context.deps.dispatcher.start).toHaveBeenCalledTimes(1);
    expect(context.deps.reconciler.start).toHaveBeenCalledTimes(1);
  });

  /**
   * Each position is load-bearing, and the whole sequence is the reverse of the
   * shutdown one:
   *
   *   - the producer's queues are constructed first, so BullMQ's handshake and
   *     Lua script loading fail as a visible startup problem rather than inside
   *     the first publish, where they look like a slow queue;
   *   - the queue workers start next, so something is consuming before anything
   *     produces;
   *   - the dispatcher starts third, because it is what turns committed outbox
   *     rows into jobs;
   *   - the reconciler is last, being a recovery mechanism rather than a
   *     delivery path — a restarting fleet is itself a source of stalled jobs,
   *     so sweeping before the rest has settled examines runs whose recovery is
   *     already in progress.
   */
  it('constructs queues, then consumes, then produces, then reconciles', () => {
    startWorkerRuntime(context.deps);

    expect(context.order).toEqual([
      'producer.init',
      'runner.start',
      'dispatcher.start',
      'reconciler.start',
    ]);
  });

  /**
   * The mutation this test exists for: deleting `deps.reconciler.start()` from
   * the sequence left the entire suite green, so the reconciler could ship
   * completely inert — the sweep never running, stalled runs never recovered,
   * and no signal anywhere that recovery had been switched off.
   *
   * Asserted on its own, separately from the order above, so it survives any
   * later rewrite of how the sequence is expressed.
   */
  it('starts the reconciler, without which stalled runs are never recovered', () => {
    startWorkerRuntime(context.deps);

    expect(context.deps.reconciler.start).toHaveBeenCalledTimes(1);
    expect(context.order).toContain('reconciler.start');
  });
});
