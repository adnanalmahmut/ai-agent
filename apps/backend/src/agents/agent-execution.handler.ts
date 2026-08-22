import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE_NAMES, type QueueJobHandler } from '../core/queue';
import { isAgentConfigurationError } from './agent-configuration.error';
import { AgentRunService } from './agent-run.service';
import { AgentRunner } from './agent-runner.service';
import { AGENT_EXECUTION_FAILED, type AgentRuntimeResult } from './agent.types';

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
      /**
       * The one thing read from the caught value, and only its identity.
       *
       * `AgentConfigurationError` can be constructed by nothing but this
       * repository, so a failing provider cannot talk the worker out of its
       * retries by choosing an error name or message. Everything else about the
       * error — text, cause, stack — stays unread.
       */
      const deterministic = isAgentConfigurationError(error);

      const attempts = job.opts.attempts ?? 1;

      /**
       * A deterministic failure is final on first sight. The budget exists for
       * conditions that change on their own, and a definition this deployment
       * does not carry is not one — spending two more attempts with exponential
       * backoff only delays the report.
       */
      const final = deterministic || job.attemptsMade + 1 >= attempts;

      const recorded = await this.runs.recordExecutionFailure(
        run.id,
        run.attemptCount,
        diagnostic,
        final,
      );

      /**
       * Everything persisted and rethrown is the same constant, so without this
       * line a missing definition, a runtime mismatch and a provider timeout are
       * indistinguishable to an operator. The code is chosen here, at the throw
       * site, and the identifying fields are application-owned columns rather
       * than anything derived from the error.
       */
      this.logger.warn(
        {
          runId: run.id,
          agentId: run.agentId,
          agentVersion: run.agentVersion,
          attemptCount: run.attemptCount,
          attemptsStarted: job.attemptsStarted,
          reason: reasonFor(deterministic, recorded),
          final,
        },
        'Agent execution attempt failed',
      );

      /**
       * `UnrecoverableError` only when this delivery actually wrote the terminal
       * outcome, which it can only have done while holding the claim: the write
       * matches on `status = RUNNING` and the exact `attemptCount`, and it sets
       * the run `FAILED`.
       *
       * From a delivery that has lost its claim the same throw would be
       * actively harmful. A newer delivery of this job is executing right now,
       * and terminally failing the job on its behalf would end work that is
       * still running and still owns the run. A stale delivery therefore rejects
       * like any other failure and lets BullMQ's own lock arbitrate.
       *
       * Pairing the two is what makes stopping the retries safe. Making this
       * unrecoverable without forcing the durable failure final would stop the
       * job while leaving the run `RUNNING` — trading a wasted retry budget for
       * a stranded row.
       */
      if (deterministic && recorded) throw new UnrecoverableError(diagnostic);

      // BullMQ must see a rejection to preserve retries, but provider messages
      // and response bodies must not be copied into Redis failedReason or logs.
      throw new Error(diagnostic);
    }

    /**
     * Wrapped, even though it is the success path.
     *
     * This call carries the model's output as an argument, and Prisma renders a
     * rejected invocation's arguments into its message — so a value the adapter
     * cannot persist would put the model's output into the error, into BullMQ's
     * `failedReason` in Redis, and into the queue's failure log, all outside
     * every piece of containment above. Unreachable while a runtime returns a
     * string, which is exactly why it is worth closing before one returns
     * anything else.
     *
     * Rethrown rather than swallowed: the durable write did not happen, so
     * BullMQ must see a failure and retry.
     */
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

/**
 * The fixed operator vocabulary for a failed attempt.
 *
 * A failed durable write outranks the classification: whatever went wrong with
 * the execution, the fact worth reporting is that this delivery no longer owns
 * the run and its outcome belongs to somebody else.
 */
function reasonFor(
  deterministic: boolean,
  recorded: boolean,
): 'claim_lost' | 'configuration_error' | 'runtime_error' {
  if (!recorded) return 'claim_lost';
  return deterministic ? 'configuration_error' : 'runtime_error';
}
