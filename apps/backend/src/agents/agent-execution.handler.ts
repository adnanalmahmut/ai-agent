import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';

import { QUEUE_NAMES, type QueueJobHandler } from '../core/queue';
import { AgentRunService } from './agent-run.service';
import { AgentRunner } from './agent-runner.service';

export type AgentExecutionJob = { runId: string };

@Injectable()
export class AgentExecutionHandler implements QueueJobHandler<AgentExecutionJob> {
  readonly queue = QUEUE_NAMES.agentExecution;
  readonly jobName = 'execute';

  constructor(
    private readonly runs: AgentRunService,
    private readonly runner: AgentRunner,
  ) {}

  async handle(job: Job<AgentExecutionJob>): Promise<void> {
    const runId = job.data?.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new Error('Agent execution job requires a runId');
    }

    const run = await this.runs.claimExecutionAttempt(
      runId,
      job.attemptsStarted,
    );
    if (!run) return;

    try {
      const result = await this.runner.run(run);
      const recorded = await this.runs.markExecutionSucceeded(
        run.id,
        run.attemptCount,
        result.output,
      );

      if (!recorded) {
        throw new Error(`AgentRun "${run.id}" lost its execution claim`);
      }
    } catch {
      const attempts = job.opts.attempts ?? 1;
      const final = job.attemptsMade + 1 >= attempts;
      const diagnostic = safeFailureDiagnostic();
      await this.runs.recordExecutionFailure(
        run.id,
        run.attemptCount,
        diagnostic,
        final,
      );

      // BullMQ must see a rejection to preserve retries, but provider messages
      // and response bodies must not be copied into Redis failedReason or logs.
      throw new Error(diagnostic);
    }
  }
}

/** Never persist provider messages, response bodies, stacks, or causes. */
function safeFailureDiagnostic(): string {
  return 'Agent execution failed';
}
