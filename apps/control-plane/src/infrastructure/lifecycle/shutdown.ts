export type ShutdownLogger = {
  info: (context: object, message: string) => void;
  error: (context: object, message: string) => void;
};

export type ShutdownBudget = {
  remaining: () => number;
  allow: (componentMaxMs: number, reserveMs?: number) => number;
};

export type ShutdownStep = {
  name: string;
  run: (budget: ShutdownBudget) => Promise<void> | void;
};

export type ShutdownOutcome = {
  completed: string[];
  failed: string[];
  timedOut: boolean;
};

export type RunShutdownOptions = {
  logger: ShutdownLogger;
  timeoutMs: number;
  onTimeout?: () => void;
};

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
      { timeoutMs, completed: outcome.completed, failed: outcome.failed },
      'Shutdown exceeded its deadline; exiting without finishing',
    );
    (onTimeout ?? (() => process.exit(1)))();
  };

  const deadlineAt = Date.now() + timeoutMs;

  const budget: ShutdownBudget = {
    remaining: () => Math.max(deadlineAt - Date.now(), 0),
    allow: (componentMaxMs, reserveMs = 0) =>
      Math.max(Math.min(componentMaxMs, budget.remaining() - reserveMs), 0),
  };

  const deadline = setTimeout(expire, timeoutMs);
  deadline.unref();

  try {
    for (const step of steps) {
      try {
        await step.run(budget);
        outcome.completed.push(step.name);
        logger.info(
          { step: step.name, remainingMs: budget.remaining() },
          'Shutdown step complete',
        );
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
