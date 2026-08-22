import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { agentsConfig } from '../config';
import { QUEUE_NAMES, QueueProducer } from '../core/queue';
import { AgentRunService } from './agent-run.service';

/** What one pass did, so a caller and a test can assert the same numbers. */
export type ReconciliationPass = {
  examined: number;
  failed: number;
  missing: number;
  pending: number;
  reconciled: number;
  /**
   * Candidates the pass never reached because shutdown began.
   *
   * Reported rather than left implicit: without it `pending + failed + missing`
   * silently stops adding up to `examined`, which reads as lost work instead of
   * an abandoned tail. Nothing is lost — the next pass rebuilds the list.
   */
  abandoned: number;
};

/**
 * Makes a run terminal when the transport has terminally failed its job.
 *
 * The gap this closes is specific and was verified against BullMQ 6.1.2 rather
 * than inferred. When a job exceeds `maxStalledCount`, `moveStalledJobsToWait`
 * writes a deferred-failure marker onto the job hash and returns the job to
 * `wait`; the next worker to fetch it converts that marker into a synthetic
 * `UnrecoverableError` and fails the job *without calling the processor*. No
 * application code runs, so nothing writes the durable failure, and the
 * `AgentRun` stays `RUNNING` forever. The handler cannot fix this, because the
 * handler is precisely what is skipped.
 *
 * ## Why a sweep, and only a sweep
 *
 * `QueueEvents` looks like the obvious answer and is not a correct one. Its
 * consumer is a plain `XREAD` starting at `$` with no cursor persisted anywhere
 * (BullMQ 6.1.2 has no consumer groups at all), so an event published while
 * this process is down is lost permanently rather than delivered late. The
 * stream is also trimmed to roughly ten thousand entries, and its listeners are
 * not awaited — an `async` listener that rejects becomes an unhandled rejection
 * and takes the process down. A mechanism that loses its input across a restart
 * cannot be the thing that guarantees eventual consistency.
 *
 * So correctness rests entirely on this pass, and the pass depends on nothing
 * held in memory: it re-derives its candidates from PostgreSQL every time.
 * Restarting the worker, or running several of them, changes only how quickly a
 * stranded run is noticed.
 *
 * ## Why PostgreSQL drives it
 *
 * The other direction — page the Redis failed set and look each job up in
 * PostgreSQL — re-reads thousands of jobs that were reconciled long ago, and
 * asks a disposable store to enumerate the work of the authoritative one.
 * Driving from the non-terminal rows keeps the candidate set proportional to
 * the problem, and each candidate then costs one `getJobState` on the
 * connection the producer already holds.
 *
 * ## What it will not do
 *
 * It never re-queues. A fresh job would restart `attemptsStarted` at 1 while the
 * run still holds a higher `attemptCount`, so the monotonic fence would reject
 * the claim, the handler would return normally, and BullMQ would record a
 * completed job for work that never ran. Re-running a failed run is a separate
 * operation with its own semantics, and this is not it.
 *
 * It also never fails a run for being slow. A run is finalized only when BullMQ
 * says its job is in the failed set. A missing job is left alone and logged:
 * absence proves nothing, and the alternative — a duration after which a live
 * run is declared dead — is a policy this slice has no evidence to set.
 */
@Injectable()
export class AgentRunReconciler {
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  /** Held so `stop()` can wait for a pass rather than cut Redis out from it. */
  private inFlight: Promise<ReconciliationPass> | undefined;

  constructor(
    private readonly runs: AgentRunService,
    private readonly producer: QueueProducer,
    @Inject(agentsConfig.KEY)
    private readonly config: ConfigType<typeof agentsConfig>,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Begins sweeping.
   *
   * Re-armed after each pass rather than run on a fixed interval, matching the
   * outbox dispatcher and for the same reason: `setInterval` would start a
   * second pass while the first was still waiting on Redis or PostgreSQL.
   *
   * The first pass is delayed by a full interval instead of running at once. A
   * worker restart is itself a source of stalled jobs, and sweeping before the
   * fleet has settled would examine runs whose recovery is still in progress.
   */
  start(): void {
    if (this.timer || this.stopping) return;

    this.logger.info(
      {
        intervalMs: this.config.reconcile.intervalMs,
        staleAfterMs: this.config.reconcile.staleAfterMs,
        batchSize: this.config.reconcile.batchSize,
      },
      'Agent run reconciler started',
    );

    this.scheduleNext(this.config.reconcile.intervalMs);
  }

  /**
   * Stops sweeping and lets the pass in progress settle within the budget.
   *
   * Abandoning a pass is safe by construction. It holds no lease and no claim,
   * writes each run independently, and rebuilds its candidate list from
   * PostgreSQL next time — so a pass cut short costs latency and nothing else.
   */
  async stop(maxWaitMs = this.config.reconcile.intervalMs): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const pass = this.inFlight;

    if (pass) {
      let timer: NodeJS.Timeout | undefined;

      try {
        await Promise.race([
          // A pass that failed on its way out has already logged; either way
          // nothing of ours is still running.
          pass.then(
            () => undefined,
            () => undefined,
          ),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(maxWaitMs, 0));
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    this.logger.info('Agent run reconciler stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;

      const pass = this.reconcileOnce();
      this.inFlight = pass;

      void pass
        .catch((error: unknown) => {
          /**
           * Reached when PostgreSQL or Redis was unreachable for the pass. It is
           * logged and dropped on purpose: the next pass recomputes its
           * candidates from scratch, so an outage costs one interval rather than
           * the loop. Nothing durable was written, and nothing needs undoing.
           *
           * This is the only place the component logs a message it did not
           * write, and it is safe because of what cannot reach here: the
           * reconciler never invokes a runtime, so no provider error, prompt or
           * response body exists on this path — only a Prisma or ioredis
           * infrastructure error, whose text is what makes an outage
           * diagnosable. The message alone, never the stack or cause.
           */
          this.logger.warn(
            { err: error instanceof Error ? { message: error.message } : {} },
            'Agent run reconciliation pass failed; retrying next interval',
          );
        })
        .finally(() => {
          this.inFlight = undefined;
          this.scheduleNext(this.config.reconcile.intervalMs);
        });
    }, delayMs);
  }

  /**
   * One pass. Public so a test can run exactly one instead of racing a timer.
   */
  async reconcileOnce(): Promise<ReconciliationPass> {
    const { staleAfterMs, batchSize } = this.config.reconcile;
    const candidates = await this.runs.findStaleNonTerminal(
      new Date(Date.now() - staleAfterMs),
      batchSize,
    );

    const pass: ReconciliationPass = {
      examined: candidates.length,
      failed: 0,
      missing: 0,
      pending: 0,
      reconciled: 0,
      abandoned: 0,
    };

    if (candidates.length === 0) return pass;

    /**
     * Sequential rather than concurrent, following the outbox dispatcher: a
     * batch fanned out against a degraded Redis produces `batchSize` slow
     * commands at once instead of one, and there is nothing to gain by
     * finishing a recovery sweep faster.
     */
    for (const [index, candidate] of candidates.entries()) {
      if (this.stopping) {
        pass.abandoned = candidates.length - index;
        break;
      }

      /**
       * The job id is the run id. Acceptance writes the outbox event with the
       * run id as its dedupe key, and the dispatcher passes that through as the
       * BullMQ `jobId`, so no mapping table is needed to go from a stranded row
       * to the job that was supposed to execute it.
       */
      const state = await this.producer.jobTransportState(
        QUEUE_NAMES.agentExecution,
        candidate.id,
      );

      if (state === 'pending') {
        pass.pending += 1;
        continue;
      }

      if (state === 'missing') {
        pass.missing += 1;

        /**
         * Logged, not failed. Redis dropped the job — retention removed it, or
         * the outbox has not published it yet — and neither proves the work
         * will not happen. Failing on absence would turn a queue backlog older
         * than the staleness threshold into destroyed work.
         */
        this.logger.warn(
          {
            runId: candidate.id,
            previousStatus: candidate.status,
            reason: 'transport_record_missing',
          },
          'Agent run has no transport record; leaving its state unchanged',
        );
        continue;
      }

      pass.failed += 1;

      const reconciled = await this.runs.reconcileTerminalFailure(candidate.id);
      if (!reconciled) continue;

      pass.reconciled += 1;

      this.logger.warn(
        {
          runId: candidate.id,
          previousStatus: candidate.status,
          attemptCount: candidate.attemptCount,
          reason: 'terminal_transport_failure',
        },
        'Agent run finalized as failed because its queue job failed terminally',
      );
    }

    if (pass.reconciled > 0 || pass.missing > 0 || pass.abandoned > 0) {
      this.logger.info(pass, 'Agent run reconciliation pass completed');
    }

    return pass;
  }
}
