import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { agentsConfig } from '../infrastructure/config';
import { QUEUE_NAMES, QueueProducer } from '../infrastructure/queue';
import { AgentRunService, type StaleRunCursor } from './agent-run.service';
import { isMcpSessionExpired, MCP_SESSION_RUNTIME } from './agent.types';

/** How many stranded run ids one summary line names before it stops. */
const MISSING_SAMPLE_SIZE = 5;

/** What one pass did, so a caller and a test can assert the same numbers. */
export type ReconciliationPass = {
  examined: number;
  failed: number;
  missing: number;
  pending: number;
  reconciled: number;
  /**
   * MCP sessions this pass finalized because their lifetime had run out.
   *
   * Counted separately from `reconciled` because it is not a reconciliation:
   * nothing failed and no transport was consulted. It is a session ending the
   * only way an abandoned one can.
   */
  expiredSessions: number;
  /** Sessions seen while still inside their lifetime, and so left alone. */
  liveSessions: number;
  /**
   * Expired sessions whose outcome somebody else had already written.
   *
   * Counted rather than ignored so that `pending + failed + missing +
   * expiredSessions + liveSessions + racedSessions + abandoned` still accounts
   * for every candidate the pass examined. A pass that silently drops a branch
   * reads as lost work, which is the same reason `abandoned` exists.
   */
  racedSessions: number;
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

  /**
   * Where the last pass stopped reading, so the next one resumes.
   *
   * Progress, not correctness. A candidate the pass cannot act on is left
   * unwritten, so oldest-first would return it again forever and — once enough
   * of them exist to fill a page — would never reach a newer stranded run at
   * all. Resuming past what has been seen bounds each row to one visit per
   * cycle.
   *
   * It moves only for a *finished* observation, which for a failed job means
   * after the terminal write resolves; see `advancePast`.
   *
   * Losing it costs nothing but time. A restart resumes from the oldest run and
   * walks the same cycle again, which is why correctness still rests on
   * PostgreSQL alone and not on anything this process remembers.
   */
  private cursor: StaleRunCursor | undefined;

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

  /**
   * Marks a candidate finished, so the next pass starts after it.
   *
   * Called per branch rather than once after the transport answers, because
   * "reached" and "finished" are not the same event for every verdict and only
   * the second one is safe to skip past. On the failed branch that means after
   * the write settles — before the logging, which is not part of the
   * observation.
   */
  private advancePast(candidate: { id: string; updatedAt: Date }): void {
    this.cursor = { updatedAt: candidate.updatedAt, id: candidate.id };
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
           * Reached when PostgreSQL or Redis was unreachable for the pass, or
           * when a terminal write rejected. It is logged and dropped on purpose:
           * the next pass recomputes its candidates from scratch and — since
           * the cursor advances only past a finished observation — is handed the
           * candidate this pass failed on. Nothing durable was written, and
           * nothing needs undoing.
           *
           * This is the only place the component logs a message it did not
           * write, and it is bounded by what cannot reach here: the reconciler
           * never invokes a runtime, so no provider error, prompt or response
           * body exists on this path — only a Prisma or ioredis infrastructure
           * error, whose text is what makes an outage diagnosable. The message
           * alone, never the stack or cause.
           *
           * Not a claim that the text is contentless. A Prisma initialization
           * error names the database host and port (`P1001`) or the database
           * user (`P1000`), so the ceiling here is deployment topology, not
           * business data and not a credential — which is the accepted cost of
           * being able to tell one outage from another. Narrowing this to an
           * error code would be a change of judgement about infrastructure
           * telemetry generally, not about this component.
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
      this.cursor,
    );

    const pass: ReconciliationPass = {
      examined: candidates.length,
      failed: 0,
      missing: 0,
      pending: 0,
      reconciled: 0,
      expiredSessions: 0,
      liveSessions: 0,
      racedSessions: 0,
      abandoned: 0,
    };

    /**
     * Collected and reported once, rather than a line per candidate per pass.
     * These runs are by definition ones nothing will change, so logging each of
     * them every interval produces an unbounded stream describing a static set.
     */
    const missing: string[] = [];

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
       * A session is finalized here, and never asked about over the transport.
       *
       * It has no job by design — acceptance appends no outbox event — so the
       * transport would answer `missing` for every session on every pass, and
       * `missing` is deliberately not a terminal verdict. Left to that path a
       * session would stay `RUNNING` forever while being logged as a stranded
       * row indefinitely: a durable lie about a session that ended, plus an
       * unbounded stream of lines describing it.
       *
       * Age is the only signal needed, and it is sufficient: a session's
       * lifetime is absolute from acceptance, so whether it is over is a
       * property of the row rather than of anything a client might still be
       * doing. A session inside its lifetime is left strictly alone.
       */
      if (candidate.runtime === MCP_SESSION_RUNTIME) {
        if (!isMcpSessionExpired(candidate.createdAt, new Date())) {
          pass.liveSessions += 1;
          this.advancePast(candidate);
          continue;
        }

        const closed = await this.runs.closeMcpSession({
          id: candidate.id,
          organizationId: candidate.organizationId,
          closedBy: 'expiry',
        });

        // False means the client closed it first, between the read above and
        // this write. Its own outcome stands; there is nothing to correct —
        // but the candidate is still counted, so the pass adds up.
        if (closed) pass.expiredSessions += 1;
        else pass.racedSessions += 1;
        this.advancePast(candidate);
        continue;
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
        this.advancePast(candidate);
        continue;
      }

      if (state === 'missing') {
        pass.missing += 1;

        /**
         * Recorded, not failed. Redis dropped the job — retention removed it,
         * or the outbox has not published it yet — and neither proves the work
         * will not happen. Failing on absence would turn a queue backlog older
         * than the staleness threshold into destroyed work.
         */
        missing.push(candidate.id);
        this.advancePast(candidate);
        continue;
      }

      pass.failed += 1;

      const reconciled = await this.runs.reconcileTerminalFailure(candidate.id);

      /**
       * After the write, never before it. `pending` and `missing` are finished
       * observations the moment the transport answers — there is nothing left
       * to do for those rows — but a `failed` verdict is only half of one, and
       * the durable write is the other half.
       *
       * Advancing on the verdict alone would mean a PostgreSQL blip during that
       * write left the cursor pointing past a run this pass had already proven
       * needs finalizing. That is not one interval of latency: nothing writes
       * the row, so its `updatedAt` never moves and the only thing that would
       * bring it back is the cursor wrapping — which requires reaching a short
       * page, and a backlog that keeps filling pages may not produce one for a
       * long time, or at all. The run this component exists to finalize would
       * stay `RUNNING` while the sweep reported healthy passes.
       *
       * A rejection here therefore propagates with the cursor still behind this
       * candidate, so the next pass is handed the same row and tries again.
       * `false` — a run another writer already made terminal — is a completed
       * observation like any other and advances normally.
       */
      this.advancePast(candidate);

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

    /**
     * A short page is the end of the cycle, so the next pass starts again from
     * the oldest run and anything that went stale behind the cursor meanwhile
     * is picked up.
     *
     * After the loop, not before it: the loop advances the cursor per candidate
     * it finishes, so resetting first would simply be overwritten and the wrap
     * would cost an extra empty query every cycle.
     *
     * Only reached when the loop ran to completion, so a pass that throws
     * leaves the cursor behind the candidate it failed on and the next pass is
     * handed that row first. That is a latency property rather than a
     * correctness one: wrapping would re-scan from the oldest row, where an
     * unreconciled candidate is still stale, still non-terminal and therefore
     * still in the result set. A wrap re-presents; it never skips.
     */
    if (candidates.length < batchSize) this.cursor = undefined;

    if (missing.length > 0) {
      this.logger.warn(
        {
          reason: 'transport_record_missing',
          count: missing.length,
          // A sample, so one line stays one line however large the set grows.
          runIds: missing.slice(0, MISSING_SAMPLE_SIZE),
        },
        'Agent runs have no transport record; leaving their state unchanged',
      );
    }

    if (
      pass.reconciled > 0 ||
      pass.missing > 0 ||
      pass.abandoned > 0 ||
      pass.expiredSessions > 0
    ) {
      this.logger.info(pass, 'Agent run reconciliation pass completed');
    }

    return pass;
  }
}
