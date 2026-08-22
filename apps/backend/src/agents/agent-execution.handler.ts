import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE_NAMES, type QueueJobHandler } from '../core/queue';
import { AgentRunService } from './agent-run.service';
import { AgentRunner } from './agent-runner.service';
import type { AgentRuntimeResult } from './agent.types';

export type AgentExecutionJob = { runId: string };

@Injectable()
export class AgentExecutionHandler implements QueueJobHandler<AgentExecutionJob> {
  readonly queue = QUEUE_NAMES.agentExecution;
  readonly jobName = 'execute';

  constructor(
    private readonly runs: AgentRunService,
    private readonly runner: AgentRunner,
    private readonly logger: PinoLogger,
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

    const diagnostic = safeFailureDiagnostic();
    let result: AgentRuntimeResult;

    try {
      result = await this.runner.run(run);
    } catch {
      const attempts = job.opts.attempts ?? 1;
      const final = job.attemptsMade + 1 >= attempts;

      // Everything persisted and rethrown is the same constant, so without a
      // log line a missing definition, a runtime mismatch and a provider
      // timeout are indistinguishable to an operator. The classification comes
      // from the throw site, never from the error object: a provider error can
      // carry anything in its message or name, so none of it is read here.
      this.logger.warn(
        {
          runId: run.id,
          attemptCount: run.attemptCount,
          attemptsStarted: job.attemptsStarted,
          reason: 'runtime_error',
          final,
        },
        'Agent execution attempt failed',
      );

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

    const recorded = await this.runs.markExecutionSucceeded(
      run.id,
      run.attemptCount,
      result.output,
    );
    if (recorded) return;

    // A newer delivery claimed the run while this model call was in flight, so
    // that delivery owns the outcome and this worker records nothing — writing
    // a failure here would target an attempt it no longer holds. BullMQ still
    // needs a rejection, because this delivery did not complete the work.
    this.logger.warn(
      {
        runId: run.id,
        attemptCount: run.attemptCount,
        attemptsStarted: job.attemptsStarted,
        reason: 'claim_lost',
      },
      'Agent execution attempt lost its claim before recording success',
    );

    throw new Error(diagnostic);
  }
}

/** Never persist provider messages, response bodies, stacks, or causes. */
function safeFailureDiagnostic(): string {
  return 'Agent execution failed';
}
