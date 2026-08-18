import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  onTerminationSignal,
  runShutdownSequence,
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
