import { Injectable } from '@nestjs/common';
import type { RuntimeStep } from '@repo/execution-contracts';

import { isAgentConfigurationError } from '../../ai/agents/agent-configuration.error';
import { AGENT_EXECUTION_FAILED } from '../../ai/agents/agent.types';
import { AgentRunService } from '../../ai/execution/agent-run.service';
import { ExecutionStepAssembler } from './execution-step.assembler';

/**
 * What a caller may ask for: a run, and at most an assertion about whose it is.
 *
 * `assertedOrganizationId` is never the source of the answer. It exists so a
 * caller that believes it is acting for one tenant is told when the Control
 * Plane disagrees, rather than quietly handed another tenant's work.
 */
export type LeaseExecutionStepCommand = {
  readonly runId: string;
  readonly assertedOrganizationId?: string;
};

export type LeaseExecutionStepOutcome =
  /** No such run, or not the tenant the caller asserted. Deliberately one shape. */
  | { readonly status: 'not_found' }
  /** Terminal, already claimed by a newer attempt, or lost the race. */
  | { readonly status: 'not_claimed' }
  /** Durable state cannot produce a valid step; the run was failed for it. */
  | { readonly status: 'not_executable'; readonly diagnostic: string }
  | { readonly status: 'leased'; readonly step: RuntimeStep };

/**
 * Handing one unit of execution to a service outside this process.
 *
 * Two properties make this a boundary rather than a hole. The attempt ordinal
 * is derived here, from durable state, so the fencing token is not something a
 * caller can choose — asking for a large one is how an out-of-date worker
 * would otherwise steal a run in flight. And the claim happens before the
 * document is assembled, so a step only ever describes work its holder owns.
 */
@Injectable()
export class LeaseExecutionStepUseCase {
  constructor(
    private readonly runs: AgentRunService,
    private readonly assembler: ExecutionStepAssembler,
  ) {}

  async execute(
    command: LeaseExecutionStepCommand,
  ): Promise<LeaseExecutionStepOutcome> {
    const existing = await this.runs.findById(command.runId);

    // A caller that named another tenant's run learns nothing it did not
    // already supply: the two failures are one answer on purpose.
    if (!existing) return { status: 'not_found' };
    if (
      command.assertedOrganizationId !== undefined &&
      command.assertedOrganizationId !== existing.organizationId
    ) {
      return { status: 'not_found' };
    }

    const run = await this.runs.claimExecutionAttempt(
      command.runId,
      existing.attemptCount + 1,
    );

    if (!run) return { status: 'not_claimed' };

    try {
      return { status: 'leased', step: await this.assembler.assemble(run) };
    } catch (error) {
      if (!isAgentConfigurationError(error)) throw error;

      // Deterministic: the same durable state produces the same contradiction
      // on every attempt, so the claim is settled here rather than left
      // RUNNING for reconciliation to time out.
      await this.runs.recordExecutionFailure(
        run.id,
        run.attemptCount,
        AGENT_EXECUTION_FAILED,
        true,
      );

      return { status: 'not_executable', diagnostic: AGENT_EXECUTION_FAILED };
    }
  }
}
