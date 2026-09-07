import { Injectable } from '@nestjs/common';
import {
  validateRuntimeStepResult,
  type ContractIssue,
  type RuntimeStepResult,
} from '@repo/execution-contracts';

import { isAgentConfigurationError } from '../../ai/agents/agent-configuration.error';
import { AgentDefinitionRegistry } from '../../ai/agents/agent-definition.registry';
import {
  AGENT_EXECUTION_FAILED,
  type AgentRun,
  type AgentValue,
} from '../../ai/agents/agent.types';
import { AgentRunService } from '../../ai/execution/agent-run.service';
import { stepIdFor } from './execution-step.assembler';

export type SettleExecutionStepCommand = {
  readonly runId: string;
  readonly assertedOrganizationId?: string;
  /** Exactly as it arrived. Nothing reads a field before the contract has. */
  readonly document: unknown;
};

export type SettleExecutionStepOutcome =
  | { readonly status: 'not_found' }
  | {
      readonly status: 'invalid_document';
      readonly issues: readonly ContractIssue[];
    }
  /** The document is valid but describes other work than the route names. */
  | { readonly status: 'identity_mismatch' }
  /** A valid outcome this boundary does not perform yet; nothing was written. */
  | { readonly status: 'unsupported_outcome'; readonly outcome: string }
  /** The submitter no longer holds the attempt it is answering for. */
  | { readonly status: 'stale' }
  /** The output does not satisfy the pinned definition; recorded as a failure. */
  | { readonly status: 'output_rejected' }
  | { readonly status: 'settled' }
  /** The identical result was already applied. Replaying it changed nothing. */
  | { readonly status: 'already_settled' }
  /** A different result for an identity that is already settled. */
  | { readonly status: 'conflict' };

/**
 * Applying a result produced outside this process.
 *
 * The order is the security property. The document is validated against the
 * published contract before any field of it is read; durable authority is
 * reloaded rather than taken from the document; the attempt ordinal in the
 * document must still be the one the run holds; and the answer itself is
 * checked against the definition the run was pinned to, so an external
 * runtime cannot widen its own output contract by returning something else.
 *
 * Only then does an existing compare-and-set apply it. Nothing here writes
 * outside `AgentRunService`, and no text the submitter chose is persisted:
 * `SafeFailure` is a classification, and the diagnostic stored is this
 * system's own.
 */
@Injectable()
export class SettleExecutionStepUseCase {
  constructor(
    private readonly runs: AgentRunService,
    private readonly definitions: AgentDefinitionRegistry,
  ) {}

  async execute(
    command: SettleExecutionStepCommand,
  ): Promise<SettleExecutionStepOutcome> {
    const checked = validateRuntimeStepResult(command.document);

    if (!checked.ok) {
      return { status: 'invalid_document', issues: checked.issues };
    }

    const result = checked.value;

    if (
      result.runId !== command.runId ||
      result.stepId !== stepIdFor(command.runId, result.attempt)
    ) {
      return { status: 'identity_mismatch' };
    }

    const run = await this.runs.findById(command.runId);

    if (!run) return { status: 'not_found' };
    if (
      command.assertedOrganizationId !== undefined &&
      command.assertedOrganizationId !== run.organizationId
    ) {
      return { status: 'not_found' };
    }

    // Tool execution stays in process: authorization, approval and settlement
    // all live here, and a proposal this boundary cannot act on must not be
    // acknowledged as though it had been.
    if (result.outcome === 'tool_request') {
      return { status: 'unsupported_outcome', outcome: result.outcome };
    }

    if (result.outcome === 'failed') return this.recordFailure(run, result);

    return this.recordSuccess(run, result);
  }

  private async recordSuccess(
    run: AgentRun,
    result: Extract<RuntimeStepResult, { outcome: 'final' }>,
  ): Promise<SettleExecutionStepOutcome> {
    const output = result.output;
    const rejection = this.outputRejection(run, output);

    if (rejection !== null) {
      // Same reading the in-process path takes: a model that returned the
      // wrong shape once may not next time, so this keeps the retry budget
      // rather than terminating the run.
      if (run.status === 'RUNNING' && run.attemptCount === result.attempt) {
        await this.runs.recordExecutionFailure(
          run.id,
          result.attempt,
          AGENT_EXECUTION_FAILED,
          false,
        );
      }

      return rejection;
    }

    const recorded = await this.runs.markExecutionSucceeded(
      run.id,
      result.attempt,
      output,
    );

    if (recorded) return { status: 'settled' };

    return this.explainLostWrite(run.id, result.attempt, output);
  }

  private async recordFailure(
    run: AgentRun,
    result: Extract<RuntimeStepResult, { outcome: 'failed' }>,
  ): Promise<SettleExecutionStepOutcome> {
    // Whether a run is finished is transport and reconciliation policy, which
    // this caller does not hold: a reported failure records a diagnostic and
    // leaves terminality to the Control Plane.
    const recorded = await this.runs.recordExecutionFailure(
      run.id,
      result.attempt,
      AGENT_EXECUTION_FAILED,
      false,
    );

    if (recorded) return { status: 'settled' };

    const current = await this.runs.findById(run.id);

    if (!current) return { status: 'not_found' };
    if (current.attemptCount !== result.attempt) return { status: 'stale' };

    // Settled at this same attempt. A second failure report agrees with what
    // is recorded and changes nothing; a failure report against a recorded
    // success contradicts it, and a contradiction must not read as a replay.
    if (current.status === 'FAILED') return { status: 'already_settled' };
    if (current.status === 'SUCCEEDED') return { status: 'conflict' };

    return { status: 'stale' };
  }

  private outputRejection(
    run: AgentRun,
    output: AgentValue,
  ): SettleExecutionStepOutcome | null {
    let definition;

    try {
      definition = this.definitions.resolve(run.agentId, run.agentVersion);
    } catch (error) {
      if (!isAgentConfigurationError(error)) throw error;

      return { status: 'output_rejected' };
    }

    const parsed = definition.output.safeParse(output);

    if (!parsed.success) return { status: 'output_rejected' };

    const parsedInput = definition.input.safeParse(run.input);

    if (!parsedInput.success) return { status: 'output_rejected' };

    const violation = definition.outputContract?.(
      parsedInput.data as AgentValue,
      parsed.data as AgentValue,
    );

    if (violation !== undefined && violation !== null) {
      return { status: 'output_rejected' };
    }

    return null;
  }

  /**
   * A compare-and-set that matched nothing is not by itself an error: the same
   * authorized result delivered twice must be idempotent, while a different
   * one for settled work must not be.
   */
  private async explainLostWrite(
    runId: string,
    attempt: number,
    output: AgentValue,
  ): Promise<SettleExecutionStepOutcome> {
    const current = await this.runs.findById(runId);

    if (!current) return { status: 'not_found' };
    if (current.attemptCount !== attempt) return { status: 'stale' };
    if (current.status !== 'SUCCEEDED') return { status: 'stale' };

    return sameJson(current.output, output)
      ? { status: 'already_settled' }
      : { status: 'conflict' };
  }
}

/** Structural equality over JSON values; property order is not part of it. */
function sameJson(left: AgentValue | null, right: AgentValue | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right) return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;

    return left.every((item, index) => sameJson(item, right[index]));
  }

  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();

    if (leftKeys.length !== rightKeys.length) return false;
    if (leftKeys.some((key, index) => key !== rightKeys[index])) return false;

    return leftKeys.every((key) =>
      sameJson(
        (left as Record<string, AgentValue>)[key],
        (right as Record<string, AgentValue>)[key],
      ),
    );
  }

  return false;
}
