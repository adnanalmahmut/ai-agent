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
import { settlementDigestOf, type SettledResult } from './attempt-settlement';
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

/** A final result carrying artifact references, which nothing settles yet. */
const UNSUPPORTED_ARTIFACTS = 'unsupported_artifacts';

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
 * What is persisted is the output as that definition normalises it, not as it
 * arrived — a schema's defaults, trims and coercions are part of what an agent
 * produces, and the in-process path has always applied them.
 *
 * Only then does a compare-and-set apply it, conditioned on the attempt not
 * having answered already: one accepted result per `(runId, attempt)`, so a
 * replay changes nothing and a contradiction is refused rather than
 * overwriting. Nothing here writes outside `AgentRunService`, and no text the
 * submitter chose is persisted: `SafeFailure` is a classification, the
 * diagnostic stored is this system's own, and the settlement record is a
 * digest.
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

    // The wire protocol carries artifact references before this boundary can
    // settle them: asset storage is later work. Accepting the result and
    // dropping the references would lose contract-valid information silently,
    // which is worse than refusing the result and writing nothing.
    if (result.artifacts.length > 0) {
      return {
        status: 'unsupported_outcome',
        outcome: UNSUPPORTED_ARTIFACTS,
      };
    }

    return this.recordSuccess(run, result);
  }

  private async recordSuccess(
    run: AgentRun,
    result: Extract<RuntimeStepResult, { outcome: 'final' }>,
  ): Promise<SettleExecutionStepOutcome> {
    const normalized = this.normalizeOutput(run, result.output);

    if (!normalized.ok) {
      // Same reading the in-process path takes: a model that returned the
      // wrong shape once may not next time, so this keeps the retry budget
      // rather than terminating the run. An attempt that has already answered
      // is left exactly as it is.
      if (
        run.status === 'RUNNING' &&
        run.attemptCount === result.attempt &&
        (run.settledAttempt === null || run.settledAttempt < result.attempt)
      ) {
        await this.runs.recordExecutionFailure(
          run.id,
          result.attempt,
          AGENT_EXECUTION_FAILED,
          false,
        );
      }

      return { status: 'output_rejected' };
    }

    const settled: SettledResult = {
      kind: 'succeeded',
      output: normalized.output,
    };
    const applied = await this.runs.settleExecutionAttempt({
      runId: run.id,
      attempt: result.attempt,
      digest: settlementDigestOf(settled),
      result: { kind: 'succeeded', output: normalized.output },
    });

    if (applied) return { status: 'settled' };

    return this.explainRefusedWrite(run.id, result.attempt, settled);
  }

  private async recordFailure(
    run: AgentRun,
    result: Extract<RuntimeStepResult, { outcome: 'failed' }>,
  ): Promise<SettleExecutionStepOutcome> {
    // Whether a run is finished is transport and reconciliation policy, which
    // this caller does not hold: a reported failure records a diagnostic and
    // leaves terminality to the Control Plane. It does settle the attempt,
    // though — the ordinal has answered, and may not answer again.
    const settled: SettledResult = {
      kind: 'failed',
      code: result.failure.code,
    };
    const applied = await this.runs.settleExecutionAttempt({
      runId: run.id,
      attempt: result.attempt,
      digest: settlementDigestOf(settled),
      result: { kind: 'failed', diagnostic: AGENT_EXECUTION_FAILED },
    });

    if (applied) return { status: 'settled' };

    return this.explainRefusedWrite(run.id, result.attempt, settled);
  }

  /**
   * The output as the pinned definition reads it, or nothing.
   *
   * `safeParse` is not only a check: a definition's schema carries defaults,
   * trims and coercions, and the value it returns is what the in-process
   * runtime has always produced. The contract is then evaluated against that
   * same value, so a contract and a persisted result can never disagree about
   * which output they were talking about.
   */
  private normalizeOutput(
    run: AgentRun,
    output: AgentValue,
  ): { ok: true; output: AgentValue } | { ok: false } {
    let definition;

    try {
      definition = this.definitions.resolve(run.agentId, run.agentVersion);
    } catch (error) {
      if (!isAgentConfigurationError(error)) throw error;

      return { ok: false };
    }

    const parsed = definition.output.safeParse(output);

    if (!parsed.success) return { ok: false };

    const parsedInput = definition.input.safeParse(run.input);

    if (!parsedInput.success) return { ok: false };

    const normalized = parsed.data as AgentValue;
    const violation = definition.outputContract?.(
      parsedInput.data as AgentValue,
      normalized,
    );

    if (violation !== undefined && violation !== null) return { ok: false };

    return { ok: true, output: normalized };
  }

  /**
   * A compare-and-set that matched nothing is not by itself an error: the same
   * authorized result delivered twice must be idempotent, while a different
   * one for settled work must not be.
   */
  private async explainRefusedWrite(
    runId: string,
    attempt: number,
    settled: SettledResult,
  ): Promise<SettleExecutionStepOutcome> {
    const current = await this.runs.findById(runId);

    if (!current) return { status: 'not_found' };

    // A settled ordinal is the authority on its own answer, whatever the run
    // has done since. Calling an identical replay stale because a newer
    // attempt has taken over would be a claim about durable state that is not
    // true, and the two answers must stay distinguishable.
    if (current.settledAttempt === attempt) {
      return current.settledResultDigest === settlementDigestOf(settled)
        ? { status: 'already_settled' }
        : { status: 'conflict' };
    }

    if (current.attemptCount !== attempt) return { status: 'stale' };

    // Terminal at this ordinal with no settlement record: the in-process
    // worker path recorded it, and that path stores results rather than
    // digests. Compare against what is actually stored, so a result the
    // Control Plane itself produced does not read as a contradiction.
    if (settled.kind === 'succeeded') {
      if (current.status !== 'SUCCEEDED') return { status: 'stale' };

      return sameJson(current.output, settled.output)
        ? { status: 'already_settled' }
        : { status: 'conflict' };
    }

    if (current.status === 'SUCCEEDED') return { status: 'conflict' };
    if (current.status === 'FAILED') return { status: 'already_settled' };

    return { status: 'stale' };
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
