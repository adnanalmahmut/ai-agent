/**
 * The logging surface a shutdown needs, and no more.
 *
 * Structural rather than `PinoLogger`, for two reasons. `PinoLogger` is a
 * transient provider, so an entrypoint has to `resolve()` it rather than `get()`
 * it — a detail this helper should not impose. And a two-method shape lets a
 * test pass a plain object instead of casting a mock through `unknown`.
 */
export type ShutdownLogger = {
  info: (context: object, message: string) => void;
  error: (context: object, message: string) => void;
};

/** One named step of a shutdown sequence. */
export type ShutdownStep = {
  name: string;
  run: () => Promise<void> | void;
};

export type ShutdownOutcome = {
  completed: string[];
  failed: string[];
  timedOut: boolean;
};

export type RunShutdownOptions = {
  logger: ShutdownLogger;
  /**
   * Hard deadline for the whole sequence.
   *
   * Not per step. What an orchestrator enforces is a single termination grace
   * period, after which it sends `SIGKILL`; a per-step budget can be satisfied
   * by every step while the total overruns it anyway.
   */
  timeoutMs: number;
  /**
   * What to do when the deadline passes. Injectable so this is testable —
   * a helper that could only be verified by watching a process die would not
   * be verified at all.
   */
  onTimeout?: () => void;
};

/**
 * Runs shutdown steps in order, and finishes whatever happens.
 *
 * Two properties, both learned from the failure modes of the obvious version:
 *
 * - A step that throws does not stop the sequence. Shutdown steps release
 *   resources, and the ones most likely to throw are the ones whose resource is
 *   already unreachable — `quit()` on a dead Redis, a queue close against a
 *   refused connection. Propagating that would strand the Prisma disconnect
 *   behind it, which is the step that actually matters.
 * - The deadline is on the whole sequence and is enforced whether or not the
 *   steps cooperate. A sequence that hangs is worse than one that fails: the
 *   orchestrator `SIGKILL`s the process mid-write instead of letting it stop.
 *
 * The order is the caller's, because it is not generic. Which step must precede
 * which is a fact about the process being shut down, and encoding a default here
 * would only make the wrong order easy.
 */
export async function runShutdownSequence(
  steps: ShutdownStep[],
  { logger, timeoutMs, onTimeout }: RunShutdownOptions,
): Promise<ShutdownOutcome> {
  const outcome: ShutdownOutcome = {
    completed: [],
    failed: [],
    timedOut: false,
  };

  const expire = () => {
    outcome.timedOut = true;
    logger.error(
      { timeoutMs, completed: outcome.completed },
      'Shutdown exceeded its deadline; exiting without finishing',
    );
    (onTimeout ?? (() => process.exit(1)))();
  };

  const deadline = setTimeout(expire, timeoutMs);
  /**
   * The watchdog must not be the reason the process stays alive. Without this,
   * a sequence that finished in a second would still hold the event loop open
   * for the rest of the timeout.
   */
  deadline.unref();

  try {
    for (const step of steps) {
      try {
        await step.run();
        outcome.completed.push(step.name);
        logger.info({ step: step.name }, 'Shutdown step complete');
      } catch (error) {
        outcome.failed.push(step.name);
        logger.error(
          {
            step: step.name,
            err: error instanceof Error ? { message: error.message } : {},
          },
          'Shutdown step failed; continuing',
        );
      }
    }
  } finally {
    clearTimeout(deadline);
  }

  return outcome;
}

/**
 * Wires termination signals to a handler, once.
 *
 * The repeat guard is not defensive tidiness. An orchestrator that considers a
 * process slow will send a second `SIGTERM`, and an operator who considers it
 * stuck will send several more; without the guard each one starts a fresh
 * concurrent sequence, so a shutdown that was merely slow becomes one that
 * closes the same connections three times and fails doing it.
 *
 * Returns a disposer, so a test can install handlers without leaking them into
 * the next test.
 */
export function onTerminationSignal(
  handler: (signal: NodeJS.Signals) => void,
  signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'],
): () => void {
  let fired = false;

  const listeners = signals.map((signal) => {
    const listener = () => {
      if (fired) return;
      fired = true;
      handler(signal);
    };

    process.on(signal, listener);
    return { signal, listener };
  });

  return () => {
    for (const { signal, listener } of listeners) {
      process.off(signal, listener);
    }
  };
}
