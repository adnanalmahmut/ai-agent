import type { AgentRunReconciler } from '../ai/execution/agent-run-reconciler.service';
import type { OutboxDispatcher } from '../infrastructure/outbox';
import type { QueueProducer, QueueWorkerRunner } from '../infrastructure/queue';

export type WorkerRuntimeDeps = {
  producer: Pick<QueueProducer, 'init'>;
  runner: Pick<QueueWorkerRunner, 'start'>;
  dispatcher: Pick<OutboxDispatcher, 'start'>;
  reconciler: Pick<AgentRunReconciler, 'start'>;
};

export function startWorkerRuntime(deps: WorkerRuntimeDeps): void {
  deps.producer.init();
  deps.runner.start();
  deps.dispatcher.start();
  deps.reconciler.start();
}
