import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE_NAMES, type QueueJobHandler } from '../../infrastructure/queue';
import { isAgentConfigurationError } from '../../ai/agents/agent-configuration.error';
import {
  AGENT_EXECUTION_FAILED,
  type AgentRuntimeResult,
} from '../../ai/agents/agent.types';
import { isAgentOutputContractError } from '../../ai/execution/agent-output-contract.error';
import { AgentRunService } from '../../ai/execution/agent-run.service';
import { AgentRunner } from '../../ai/execution/agent-runner.service';

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

    const diagnostic = AGENT_EXECUTION_FAILED;
    let result: AgentRuntimeResult;

    try {
      result = await this.runner.run(run);
    } catch (error) {
      const deterministic = isAgentConfigurationError(error);

      const contractViolation = isAgentOutputContractError(error);

      const attempts = job.opts.attempts ?? 1;

      const final = deterministic || job.attemptsMade + 1 >= attempts;

      const recorded = await this.runs.recordExecutionFailure(
        run.id,
        run.attemptCount,
        diagnostic,
        final,
      );

      this.logger.warn(
        {
          runId: run.id,
          agentId: run.agentId,
          agentVersion: run.agentVersion,
          attemptCount: run.attemptCount,
          attemptsStarted: job.attemptsStarted,
          reason: reasonFor(deterministic, contractViolation, recorded),
          final,
        },
        'Agent execution attempt failed',
      );

      if (deterministic && recorded) throw new UnrecoverableError(diagnostic);

      // BullMQ must see a rejection to preserve retries, but provider messages
      // and response bodies must not be copied into Redis failedReason or logs.
      throw new Error(diagnostic);
    }

    let recorded: boolean;

    try {
      recorded = await this.runs.markExecutionSucceeded(
        run.id,
        run.attemptCount,
        result.output,
      );
    } catch {
      this.logger.warn(
        {
          runId: run.id,
          attemptCount: run.attemptCount,
          attemptsStarted: job.attemptsStarted,
          reason: 'result_write_failed',
        },
        'Agent execution result could not be recorded',
      );

      throw new Error(diagnostic);
    }

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

function reasonFor(
  deterministic: boolean,
  contractViolation: boolean,
  recorded: boolean,
):
  | 'claim_lost'
  | 'configuration_error'
  | 'contract_violation'
  | 'runtime_error' {
  if (!recorded) return 'claim_lost';
  if (deterministic) return 'configuration_error';
  return contractViolation ? 'contract_violation' : 'runtime_error';
}
