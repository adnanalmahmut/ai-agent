import type { AgentRunReconciler } from './agents/agent-run-reconciler.service';
import type { ShutdownStep } from './core/lifecycle';
import type { ProcessReadiness } from './core/lifecycle';
import type { OutboxDispatcher } from './core/outbox';
import type { QueueProducer, QueueWorkerRunner } from './core/queue';

/**
 * Held back from the two draining steps so the closing ones are never left with
 * nothing.
 *
 * Closing a producer, a `QueueEvents` stream, a Redis client and a Prisma pool
 * is fast when they are healthy and not instant when they are not. Without a
 * reserve, a dispatcher and a worker that each used their full grace would reach
 * the closing steps with an expired deadline and be killed holding sockets open.
 */
export const CLEANUP_RESERVE_MS = 5_000;

export type WorkerShutdownDeps = {
  dispatcher: Pick<OutboxDispatcher, 'stop'>;
  reconciler: Pick<AgentRunReconciler, 'stop'>;
  readiness: Pick<ProcessReadiness, 'markDraining'>;
  runner: Pick<QueueWorkerRunner, 'stop'>;
  producer: Pick<QueueProducer, 'close'>;
  /** Usually `app.close()`; a parameter so the sequence can be exercised alone. */
  closeApplication: () => Promise<void>;
  /** `QUEUE_SHUTDOWN_GRACE_MS` — the *ceiling* on each drain, not its budget. */
  drainGraceMs: number;
};

/**
 * The worker's drain, as data.
 *
 * Extracted from `worker.ts` for one reason: `worker.ts` is an entrypoint that
 * calls `bootstrap()` on import, so a test could never exercise the real
 * sequence — only a copy of it, which would keep passing after the real one
 * changed. Here the production process and the failure-injection test build the
 * same array.
 *
 * The order is the point, and every position is load-bearing:
 *
 *   1. Stop the dispatcher. It is the only thing still *creating* work for this
 *      process, and it waits for the publish in flight — so nothing is left
 *      mid-publish when the queue closes underneath it.
 *   2. Stop the agent-run reconciler, which reads both Redis and PostgreSQL and
 *      would otherwise still be doing so when steps 4 and 5 take them away.
 *      Before the worker drain rather than after, because a reconciler pass is
 *      short and holds nothing, whereas the drain may use most of the budget.
 *   3. Fail readiness.
 *   4. Drain the queue workers: stop claiming at once, let active jobs finish,
 *      force the close if the budget runs out. Also closes `QueueEvents`, after
 *      the workers, so the last failures are still recorded.
 *   5. Close the producers.
 *   6. Close the application, which runs the module hooks that disconnect Redis
 *      and Prisma — each next to the resource it owns rather than restated here.
 *
 * Both draining steps draw from the single process-wide budget rather than from
 * their own grace periods. That is what stops the worker promising more time
 * than the process has: a stuck publish shortens the drain that follows it, and
 * whatever they leave is what the closing steps get.
 *
 * Nothing here writes business state. A job abandoned when the budget runs out
 * keeps its durable record and is recovered as stalled; an outbox row claimed
 * but not published stays `PROCESSING` until its lease expires; a reconciler
 * pass cut short simply recomputes its candidates next time. A deployment is
 * not a cancellation.
 */
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
      /**
       * Bounded by the same shared budget as every other draining step. A pass
       * abandoned here leaves nothing behind: it holds no lease and no claim,
       * and the next process rebuilds its candidate list from PostgreSQL.
       */
      name: 'stop-agent-run-reconciler',
      run: (budget) =>
        reconciler.stop(budget.allow(drainGraceMs, CLEANUP_RESERVE_MS)),
    },
    {
      /**
       * No probe reads this yet — the worker serves no HTTP. It is set here
       * anyway, at the point the sequence says it should be, so that adding a
       * probe later exposes state that has been maintained correctly all along
       * rather than retrofitting it onto a path that never considered it.
       */
      name: 'mark-not-ready',
      run: () => readiness.markDraining(),
    },
    {
      /**
       * No `QueueScheduler`: BullMQ folded it into `Worker` in v2, so delayed
       * and stalled jobs are handled by the worker itself.
       */
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
