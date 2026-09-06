import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE_NAMES, type QueueJobHandler } from '../../infrastructure/queue';
import { ExecuteAgentRunUseCase } from '../../modules/runs';

export type AgentExecutionJob = { runId: string };

/**
 * The queue side of running an agent: read what the delivery says, ask the
 * Control Plane to execute, and say back in BullMQ's vocabulary what it
 * decided. No policy lives here — which attempt is authoritative, whether a
 * failure is worth another try, and what gets written are all answered behind
 * `ExecuteAgentRunUseCase`.
 */
@Injectable()
export class AgentExecutionHandler implements QueueJobHandler<AgentExecutionJob> {
  readonly queue = QUEUE_NAMES.agentExecution;
  readonly jobName = 'execute';

  constructor(
    private readonly execution: ExecuteAgentRunUseCase,
    private readonly logger: PinoLogger,
  ) {}

  async handle(job: Job<AgentExecutionJob>): Promise<void> {
    const runId = job.data?.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new Error('Agent execution job requires a runId');
    }

    const attemptsStarted = job.attemptsStarted;

    const outcome = await this.execution.execute({
      runId,
      attempt: attemptsStarted,
      lastDelivery: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    });

    if (outcome.status === 'not_claimed' || outcome.status === 'succeeded') {
      return;
    }

    if (outcome.status === 'failed') {
      const { run } = outcome;

      this.logger.warn(
        {
          runId: run.runId,
          agentId: run.agentId,
          agentVersion: run.agentVersion,
          attemptCount: run.attemptCount,
          attemptsStarted,
          reason: outcome.reason,
          final: outcome.final,
        },
        'Agent execution attempt failed',
      );

      // Retrying a settled deterministic failure would only burn deliveries.
      if (outcome.exhausted) throw new UnrecoverableError(outcome.diagnostic);

      // BullMQ must see a rejection to preserve retries, but provider messages
      // and response bodies must not be copied into Redis failedReason or logs.
      throw new Error(outcome.diagnostic);
    }

    const { run } = outcome;

    this.logger.warn(
      {
        runId: run.runId,
        attemptCount: run.attemptCount,
        attemptsStarted,
        reason:
          outcome.status === 'result_unrecorded'
            ? 'result_write_failed'
            : 'claim_lost',
      },
      outcome.status === 'result_unrecorded'
        ? 'Agent execution result could not be recorded'
        : 'Agent execution attempt lost its claim before recording success',
    );

    // This delivery did not complete the work, so BullMQ still needs a
    // rejection even though the run itself may already be finished.
    throw new Error(outcome.diagnostic);
  }
}
