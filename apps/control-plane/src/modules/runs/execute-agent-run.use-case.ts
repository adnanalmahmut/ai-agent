import { Injectable } from '@nestjs/common';

import { isAgentConfigurationError } from '../../ai/agents/agent-configuration.error';
import { AGENT_EXECUTION_FAILED } from '../../ai/agents/agent.types';
import { isAgentOutputContractError } from '../../ai/execution/agent-output-contract.error';
import { AgentRunService } from '../../ai/execution/agent-run.service';
import { AgentRunner } from '../../ai/execution/agent-runner.service';

/**
 * What a transport knows about a delivery, expressed without naming one.
 *
 * `attempt` is the fencing token: a monotonic delivery ordinal that the durable
 * claim compares against the run's recorded attempt count. `lastDelivery` says
 * whether the caller has any redelivery left, which is the only part of the
 * final/not-final decision a transport is entitled to contribute — whether the
 * failure is worth retrying at all remains the Control Plane's call.
 */
export type ExecuteAgentRunCommand = {
  readonly runId: string;
  readonly attempt: number;
  readonly lastDelivery: boolean;
};

/** Identity of the claimed run, for the caller's own observability. */
export type ClaimedRun = {
  readonly runId: string;
  readonly agentId: string;
  readonly agentVersion: number;
  readonly attemptCount: number;
};

export type AgentRunFailureReason =
  'claim_lost' | 'configuration_error' | 'contract_violation' | 'runtime_error';

/**
 * The decision the Control Plane reached. A transport translates this into its
 * own vocabulary — acknowledge, retry, or stop retrying — and nothing more.
 */
export type ExecuteAgentRunOutcome =
  | { readonly status: 'not_claimed'; readonly runId: string }
  | { readonly status: 'succeeded'; readonly run: ClaimedRun }
  | {
      readonly status: 'failed';
      readonly run: ClaimedRun;
      readonly reason: AgentRunFailureReason;
      /** The run reached a terminal FAILED state; no further attempt applies. */
      readonly final: boolean;
      /** Retrying cannot change the answer, so the transport should stop. */
      readonly exhausted: boolean;
      readonly diagnostic: string;
    }
  | {
      readonly status: 'result_unrecorded';
      readonly run: ClaimedRun;
      readonly diagnostic: string;
    }
  | {
      readonly status: 'claim_lost';
      readonly run: ClaimedRun;
      readonly diagnostic: string;
    };

/**
 * Executing an accepted run: claim it, run it against what it was pinned to,
 * and apply the outcome under that claim.
 *
 * The claim and the result write are compare-and-set against the same attempt
 * ordinal, so a delivery that lost the run while a model call was in flight
 * writes nothing rather than overwriting a newer attempt's answer.
 */
@Injectable()
export class ExecuteAgentRunUseCase {
  constructor(
    private readonly runs: AgentRunService,
    private readonly runner: AgentRunner,
  ) {}

  async execute(
    command: ExecuteAgentRunCommand,
  ): Promise<ExecuteAgentRunOutcome> {
    const { runId } = command;

    if (typeof runId !== 'string' || runId.length === 0) {
      throw new Error('Agent execution job requires a runId');
    }

    const run = await this.runs.claimExecutionAttempt(runId, command.attempt);
    // Terminal, stale, and duplicate deliveries hold no claim and do no work.
    if (!run) return { status: 'not_claimed', runId };

    const claimed: ClaimedRun = {
      runId: run.id,
      agentId: run.agentId,
      agentVersion: run.agentVersion,
      attemptCount: run.attemptCount,
    };
    const diagnostic = AGENT_EXECUTION_FAILED;

    let output;
    try {
      ({ output } = await this.runner.run(run));
    } catch (error) {
      const deterministic = isAgentConfigurationError(error);
      const contractViolation = isAgentOutputContractError(error);
      const final = deterministic || command.lastDelivery;

      const recorded = await this.runs.recordExecutionFailure(
        run.id,
        run.attemptCount,
        diagnostic,
        final,
      );

      return {
        status: 'failed',
        run: claimed,
        reason: failureReason(deterministic, contractViolation, recorded),
        final,
        // A deterministic failure that was durably recorded is settled; every
        // other shape keeps whatever retry budget the transport still has.
        exhausted: deterministic && recorded,
        diagnostic,
      };
    }

    let recorded: boolean;
    try {
      recorded = await this.runs.markExecutionSucceeded(
        run.id,
        run.attemptCount,
        output,
      );
    } catch {
      return { status: 'result_unrecorded', run: claimed, diagnostic };
    }

    if (recorded) return { status: 'succeeded', run: claimed };

    // A newer delivery claimed the run while this model call was in flight, so
    // that delivery owns the outcome and this one records nothing — writing a
    // failure here would target an attempt it no longer holds.
    return { status: 'claim_lost', run: claimed, diagnostic };
  }
}

function failureReason(
  deterministic: boolean,
  contractViolation: boolean,
  recorded: boolean,
): AgentRunFailureReason {
  if (!recorded) return 'claim_lost';
  if (deterministic) return 'configuration_error';
  return contractViolation ? 'contract_violation' : 'runtime_error';
}
