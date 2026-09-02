import type { AgentRunReconciler } from './agents/agent-run-reconciler.service';
import type { OutboxDispatcher } from './infrastructure/outbox';
import type { QueueProducer, QueueWorkerRunner } from './infrastructure/queue';

export type WorkerRuntimeDeps = {
  producer: Pick<QueueProducer, 'init'>;
  runner: Pick<QueueWorkerRunner, 'start'>;
  dispatcher: Pick<OutboxDispatcher, 'start'>;
  reconciler: Pick<AgentRunReconciler, 'start'>;
};

/**
 * The worker's startup, as one callable thing.
 *
 * Extracted from `worker.ts` for the reason `worker.shutdown.ts` already was:
 * `worker.ts` calls `bootstrap()` on import, so nothing can exercise the real
 * sequence — only a copy of it, which keeps passing after the real one changes.
 * Forgetting to start a loop is invisible in a way that forgetting to stop one
 * is not; a background loop that never runs produces no error, no log line and
 * no failing test, only work that quietly never gets done.
 *
 * The order is the reverse of the shutdown sequence's, and each position is
 * load-bearing:
 *
 *   1. Construct the producer's queues, so BullMQ's handshake and Lua script
 *      loading happen here — where a failure is a startup problem somebody
 *      sees — rather than inside the first publish, where it looks like a slow
 *      queue.
 *   2. Start the queue workers, so there is something to consume before
 *      anything produces.
 *   3. Start the outbox dispatcher, which is what turns committed rows into
 *      jobs.
 *   4. Start the reconciler last. It is the only loop here that is a recovery
 *      mechanism rather than a delivery path, and it deliberately waits a full
 *      interval before its first pass — a restarting fleet is itself a source
 *      of stalled jobs, and sweeping before it settles would examine runs whose
 *      recovery is still in progress.
 */
export function startWorkerRuntime(deps: WorkerRuntimeDeps): void {
  deps.producer.init();
  deps.runner.start();
  deps.dispatcher.start();
  deps.reconciler.start();
}
