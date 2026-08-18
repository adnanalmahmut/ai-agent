import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  onTerminationSignal,
  runShutdownSequence,
  type ShutdownBudget,
  type ShutdownLogger,
} from './shutdown';

const silent: ShutdownLogger = { info: jest.fn(), error: jest.fn() };

describe('runShutdownSequence', () => {
  it('runs the steps in the order given', async () => {
    const order: string[] = [];

    const outcome = await runShutdownSequence(
      [
        { name: 'first', run: () => void order.push('first') },
        { name: 'second', run: () => void order.push('second') },
        { name: 'third', run: () => void order.push('third') },
      ],
      { logger: silent, timeoutMs: 5_000 },
    );

    expect(order).toEqual(['first', 'second', 'third']);
    expect(outcome).toEqual({
      completed: ['first', 'second', 'third'],
      failed: [],
      timedOut: false,
    });
  });

  it('waits for an asynchronous step before starting the next', async () => {
    const order: string[] = [];

    await runShutdownSequence(
      [
        {
          name: 'slow',
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            order.push('slow');
          },
        },
        { name: 'fast', run: () => void order.push('fast') },
      ],
      { logger: silent, timeoutMs: 5_000 },
    );

    // Overlapping them would mean closing a queue while a dispatcher was still
    // publishing to it — the exact hazard the ordering exists to prevent.
    expect(order).toEqual(['slow', 'fast']);
  });

  /**
   * The steps most likely to throw are the ones whose resource is already
   * unreachable — `quit()` on a dead Redis, a queue close against a refused
   * connection. Propagating that would strand the Prisma disconnect behind it,
   * which is the step that actually matters.
   */
  it('continues past a step that throws, and reports it', async () => {
    const after = jest.fn<() => void>();

    const outcome = await runShutdownSequence(
      [
        {
          name: 'broken',
          run: () => {
            throw new Error('connection is closed');
          },
        },
        { name: 'after', run: after },
      ],
      { logger: silent, timeoutMs: 5_000 },
    );

    expect(after).toHaveBeenCalled();
    expect(outcome.failed).toEqual(['broken']);
    expect(outcome.completed).toEqual(['after']);
  });

  it('continues past a step that rejects', async () => {
    const after = jest.fn<() => void>();

    const outcome = await runShutdownSequence(
      [
        {
          name: 'broken',
          run: () => Promise.reject(new Error('ECONNREFUSED')),
        },
        { name: 'after', run: after },
      ],
      { logger: silent, timeoutMs: 5_000 },
    );

    expect(after).toHaveBeenCalled();
    expect(outcome.failed).toEqual(['broken']);
  });

  /**
   * A hung sequence is worse than a failed one: the orchestrator's `SIGKILL`
   * lands at an arbitrary point instead of the process stopping on its own.
   */
  it('fires the deadline when the sequence overruns', async () => {
    const onTimeout = jest.fn();

    await runShutdownSequence(
      [
        {
          name: 'hangs',
          run: () => new Promise((resolve) => setTimeout(resolve, 200)),
        },
      ],
      { logger: silent, timeoutMs: 50, onTimeout },
    );

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not fire the deadline for a sequence that finishes in time', async () => {
    const onTimeout = jest.fn();

    const outcome = await runShutdownSequence(
      [{ name: 'quick', run: () => undefined }],
      { logger: silent, timeoutMs: 1_000, onTimeout },
    );

    // Deliberately longer than the sequence took, to prove the watchdog is
    // cleared rather than merely outrun.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(onTimeout).not.toHaveBeenCalled();
    expect(outcome.timedOut).toBe(false);
  });

  it('accepts an empty sequence', async () => {
    await expect(
      runShutdownSequence([], { logger: silent, timeoutMs: 1_000 }),
    ).resolves.toEqual({ completed: [], failed: [], timedOut: false });
  });
});

/**
 * One deadline for the process, shared by every bounded wait inside it.
 *
 * The alternative — each component holding its own full grace period — promises
 * more time than the process has. A worker with a 25-second dispatcher grace and
 * a 25-second drain grace inside a 30-second deadline cannot honour both, and
 * finds out only when the orchestrator kills it part-way through closing a
 * connection.
 */
describe('the shutdown budget', () => {
  const budgetOf = async (
    timeoutMs: number,
    use: (budget: ShutdownBudget) => Promise<void> | void,
  ) => {
    let captured: ShutdownBudget | undefined;

    await runShutdownSequence(
      [
        {
          name: 'capture',
          run: async (budget) => {
            captured = budget;
            await use(budget);
          },
        },
      ],
      { logger: silent, timeoutMs, onTimeout: () => undefined },
    );

    return captured as ShutdownBudget;
  };

  it('hands every step the same budget', async () => {
    const seen: ShutdownBudget[] = [];

    await runShutdownSequence(
      [
        { name: 'a', run: (budget) => void seen.push(budget) },
        { name: 'b', run: (budget) => void seen.push(budget) },
      ],
      { logger: silent, timeoutMs: 1_000 },
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('counts down from the deadline as steps consume time', async () => {
    const budget = await budgetOf(1_000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    expect(budget.remaining()).toBeLessThan(1_000);
    expect(budget.remaining()).toBeGreaterThan(0);
  });

  it('never reports a negative remainder', async () => {
    const budget = await budgetOf(60, async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(budget.remaining()).toBe(0);
  });

  /**
   * `min(componentMax, remaining - reserve)`. The component's configured grace
   * is a ceiling, not an entitlement.
   */
  it('caps a component by its own maximum when the budget is ample', async () => {
    const budget = await budgetOf(60_000, () => undefined);

    expect(budget.allow(5_000)).toBe(5_000);
  });

  it('caps a component by the remaining budget when that is tighter', async () => {
    const budget = await budgetOf(300, async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(budget.allow(25_000)).toBeLessThanOrEqual(300);
    expect(budget.allow(25_000)).toBeGreaterThan(0);
  });

  /**
   * The reserve is what stops a draining step from spending the allowance that
   * closing connections needs. Without it, a dispatcher and a worker that each
   * used their full grace would reach the closing steps with an expired deadline.
   */
  it('withholds the reserve from what a component may wait for', async () => {
    const budget = await budgetOf(10_000, () => undefined);

    const withoutReserve = budget.allow(30_000);
    const withReserve = budget.allow(30_000, 5_000);

    expect(withoutReserve - withReserve).toBe(5_000);
  });

  it('allows nothing rather than a negative wait once the reserve exceeds the remainder', async () => {
    const budget = await budgetOf(200, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    // The reserve is larger than anything that can be left: the component is
    // told to wait for nothing, which forces an immediate forced close rather
    // than a wait the process cannot afford.
    expect(budget.allow(25_000, 60_000)).toBe(0);
  });

  /**
   * The invariant the whole mechanism exists for, asserted end to end: two
   * components that each *want* the full deadline cannot between them exceed it.
   */
  it('keeps two greedy sequential waits inside the one deadline', async () => {
    const TOTAL = 400;
    const RESERVE = 100;
    const startedAt = Date.now();
    const waited: number[] = [];

    const greedy = (budget: ShutdownBudget) => {
      const allowed = budget.allow(TOTAL, RESERVE);
      waited.push(allowed);
      return new Promise<void>((resolve) => setTimeout(resolve, allowed));
    };

    await runShutdownSequence(
      [
        { name: 'first', run: greedy },
        { name: 'second', run: greedy },
        { name: 'cleanup', run: () => undefined },
      ],
      { logger: silent, timeoutMs: TOTAL, onTimeout: () => undefined },
    );

    const elapsed = Date.now() - startedAt;

    // The first takes TOTAL - RESERVE; the second gets only what is left.
    expect(waited[0]).toBeLessThanOrEqual(TOTAL - RESERVE);
    expect(waited[1]).toBeLessThan(waited[0]);
    // Generous scheduling tolerance; the assertion is "bounded", not "exact".
    expect(elapsed).toBeLessThan(TOTAL + 200);
  });
});

describe('onTerminationSignal', () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it('invokes the handler with the signal that arrived', () => {
    const handler = jest.fn();
    dispose = onTerminationSignal(handler, ['SIGUSR2']);

    process.emit('SIGUSR2');

    expect(handler).toHaveBeenCalledWith('SIGUSR2');
  });

  /**
   * An orchestrator that considers a process slow sends a second `SIGTERM`, and
   * an operator who considers it stuck sends several more. Without the guard,
   * each starts a fresh concurrent sequence closing the same connections — so a
   * shutdown that was merely slow becomes one that fails.
   */
  it('ignores every signal after the first', () => {
    const handler = jest.fn();
    dispose = onTerminationSignal(handler, ['SIGUSR2']);

    process.emit('SIGUSR2');
    process.emit('SIGUSR2');
    process.emit('SIGUSR2');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('is silent once disposed', () => {
    const handler = jest.fn();
    onTerminationSignal(handler, ['SIGUSR2'])();

    process.emit('SIGUSR2');

    expect(handler).not.toHaveBeenCalled();
  });

  it('listens on each configured signal', () => {
    const handler = jest.fn();
    dispose = onTerminationSignal(handler, ['SIGUSR2', 'SIGHUP']);

    process.emit('SIGHUP');

    expect(handler).toHaveBeenCalledWith('SIGHUP');
  });
});
