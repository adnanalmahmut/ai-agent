import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import { ProcessReadiness } from '../../../../src/infrastructure/lifecycle/readiness';
import {
  onTerminationSignal,
  runShutdownSequence,
  type ShutdownBudget,
  type ShutdownLogger,
} from '../../../../src/infrastructure/lifecycle/shutdown';

describe('ProcessReadiness', () => {
  let readiness: ProcessReadiness;

  beforeEach(() => {
    readiness = new ProcessReadiness();
  });

  it('starts not ready', () => {
    expect(readiness.status).toBe('starting');
    expect(readiness.isReady).toBe(false);
    expect(readiness.isDraining).toBe(false);
  });

  it('becomes ready once told', () => {
    readiness.markReady();

    expect(readiness.status).toBe('ready');
    expect(readiness.isReady).toBe(true);
  });

  it('becomes draining once told', () => {
    readiness.markReady();
    readiness.markDraining();

    expect(readiness.status).toBe('draining');
    expect(readiness.isReady).toBe(false);
    expect(readiness.isDraining).toBe(true);
  });

  it('never returns to ready once draining', () => {
    readiness.markReady();
    readiness.markDraining();
    readiness.markReady();

    expect(readiness.status).toBe('draining');
  });

  it('cannot be revived from draining even if it never became ready', () => {
    readiness.markDraining();
    readiness.markReady();

    expect(readiness.status).toBe('draining');
  });

  it('distinguishes starting from draining', () => {
    expect(new ProcessReadiness().status).toBe('starting');

    const draining = new ProcessReadiness();
    draining.markDraining();

    expect(draining.status).toBe('draining');
  });
});

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

    expect(order).toEqual(['slow', 'fast']);
  });

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

    expect(budget.allow(25_000, 60_000)).toBe(0);
  });

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

    expect(waited[0]).toBeLessThanOrEqual(TOTAL - RESERVE);
    expect(waited[1]).toBeLessThan(waited[0]);
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
