import type { AgentRunReconciler } from '../ai/execution/agent-run-reconciler.service';
import type { ShutdownStep } from '../infrastructure/lifecycle';
import type { ProcessReadiness } from '../infrastructure/lifecycle';
import type { OutboxDispatcher } from '../infrastructure/outbox';
import type { QueueProducer, QueueWorkerRunner } from '../infrastructure/queue';

export const CLEANUP_RESERVE_MS = 5_000;

export type WorkerShutdownDeps = {
  dispatcher: Pick<OutboxDispatcher, 'stop'>;
  reconciler: Pick<AgentRunReconciler, 'stop'>;
  readiness: Pick<ProcessReadiness, 'markDraining'>;
  runner: Pick<QueueWorkerRunner, 'stop'>;
  producer: Pick<QueueProducer, 'close'>;
  closeApplication: () => Promise<void>;
  drainGraceMs: number;
};

export function workerShutdownSteps(deps: WorkerShutdownDeps): ShutdownStep[] {
  const {
    dispatcher,
    reconciler,
    readiness,
    runner,
    producer,
    closeApplication,
    drainGraceMs,
  } = deps;

  return [
    {
      name: 'stop-outbox-dispatcher',
      run: (budget) =>
        dispatcher.stop(budget.allow(drainGraceMs, CLEANUP_RESERVE_MS)),
    },
    {
      name: 'stop-agent-run-reconciler',
      run: (budget) =>
        reconciler.stop(budget.allow(drainGraceMs, CLEANUP_RESERVE_MS)),
    },
    {
      name: 'mark-not-ready',
      run: () => readiness.markDraining(),
    },
    {
      name: 'close-queue-workers',
      run: (budget) =>
        runner.stop(budget.allow(drainGraceMs, CLEANUP_RESERVE_MS)),
    },
    {
      name: 'close-queue-producers',
      run: () => producer.close(),
    },
    {
      name: 'close-application',
      run: () => closeApplication(),
    },
  ];
}
