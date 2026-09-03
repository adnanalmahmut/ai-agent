import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { agentsConfig } from '../../infrastructure/config';
import { QUEUE_NAMES, QueueProducer } from '../../infrastructure/queue';
import {
  isMcpSessionExpired,
  MCP_SESSION_RUNTIME,
} from '../agents/agent.types';
import { AgentRunService, type StaleRunCursor } from './agent-run.service';

const MISSING_SAMPLE_SIZE = 5;

export type ReconciliationPass = {
  examined: number;
  failed: number;
  missing: number;
  pending: number;
  reconciled: number;
  expiredSessions: number;
  liveSessions: number;
  racedSessions: number;
  abandoned: number;
};

@Injectable()
export class AgentRunReconciler {
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  private inFlight: Promise<ReconciliationPass> | undefined;

  private cursor: StaleRunCursor | undefined;

  constructor(
    private readonly runs: AgentRunService,
    private readonly producer: QueueProducer,
    @Inject(agentsConfig.KEY)
    private readonly config: ConfigType<typeof agentsConfig>,
    private readonly logger: PinoLogger,
  ) {}

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

    const missing: string[] = [];

    for (const [index, candidate] of candidates.entries()) {
      if (this.stopping) {
        pass.abandoned = candidates.length - index;
        break;
      }

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

        missing.push(candidate.id);
        this.advancePast(candidate);
        continue;
      }

      pass.failed += 1;

      const reconciled = await this.runs.reconcileTerminalFailure(candidate.id);

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
