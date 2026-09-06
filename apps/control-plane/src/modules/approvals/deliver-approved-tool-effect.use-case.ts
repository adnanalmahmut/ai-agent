import { Inject, Injectable } from '@nestjs/common';

import type { AgentDefinition } from '../../ai/agents/agent.types';
import {
  SIDE_EFFECT_DELIVERY,
  type SideEffectDeliveryPort,
} from '../../ai/tools/side-effect-delivery.port';
import {
  isToolAuthorizationRefusal,
  ToolAuthorizationService,
  type AuthorizedToolEffect,
} from '../../ai/tools/tool-authorization.service';
import {
  TERMINAL_TOOL_EXECUTION_STATUSES,
  ToolExecutionService,
  type EffectSettlement,
  type SideEffectExecutionRow,
} from '../../ai/tools/tool-execution.service';
import {
  isSideEffectPreconditionError,
  type PreparedEffect,
  type ToolFailureCode,
  type ToolInvocationContext,
} from '../../ai/tools/tool.types';
import type { ExternalEffectOutcome } from '../../core/external-effect';
import type { ToolExecutionStatus } from '../../generated/prisma/client';

/**
 * How long a first attempt stays replayable. Past it, a provider that never
 * answered cannot be assumed to have done nothing.
 */
export const EFFECT_RETRY_WINDOW_MS = 20 * 60 * 60 * 1_000;

export type DeliverApprovedToolEffectCommand = {
  readonly toolExecutionId: string;
  readonly organizationId: string;
  /** Whether the caller will deliver this again if the attempt does not settle. */
  readonly lastDelivery: boolean;
};

export type ToolDeliveryReason =
  | 'missing'
  | 'already_settled'
  | 'not_approved'
  | 'payload_changed'
  | 'window_expired'
  | 'claim_lost'
  | 'refused_after_attempt'
  | 'outcome_unknown'
  | 'provider_unavailable'
  | 'settled'
  | 'settlement_lost';

/** Something the Control Plane decided, for the caller to record as it likes. */
export type ToolDeliveryRecord = {
  readonly reason: ToolDeliveryReason;
  readonly status?: ToolExecutionStatus;
  readonly failureCode?: ToolFailureCode;
};

export type DeliverApprovedToolEffectOutcome = {
  /** `retry` means this delivery did not settle the row and should come back. */
  readonly status: 'complete' | 'retry';
  readonly records: readonly ToolDeliveryRecord[];
};

/**
 * Performing a side effect that was approved earlier.
 *
 * The shape of this is deliberate: nothing that talks to a provider is reached
 * until `ToolAuthorizationService` has said yes and handed back the authorized
 * Control Plane preparer together with the pinned definition. There is no path
 * here that takes an "approved" claim from a caller, a runtime, or a job
 * payload — approval is read from the row, and revalidated against durable
 * state in the same breath.
 *
 * The preparer resolves the effective payload, computes its digest, and
 * produces a function-free delivery command. `SideEffectDeliveryPort` then
 * receives that authorized, data-only command and a stable idempotency key. It
 * has no database, no approval record, and no organization state, so a future
 * move of delivery out of this process moves an adapter and not an authority.
 */
@Injectable()
export class DeliverApprovedToolEffectUseCase {
  constructor(
    private readonly executions: ToolExecutionService,
    private readonly authorization: ToolAuthorizationService,
    @Inject(SIDE_EFFECT_DELIVERY)
    private readonly delivery: SideEffectDeliveryPort,
  ) {}

  async execute(
    command: DeliverApprovedToolEffectCommand,
  ): Promise<DeliverApprovedToolEffectOutcome> {
    const { toolExecutionId, organizationId } = command;

    if (
      typeof toolExecutionId !== 'string' ||
      toolExecutionId.length === 0 ||
      typeof organizationId !== 'string' ||
      organizationId.length === 0
    ) {
      throw new Error(
        'Side-effect delivery requires toolExecutionId and organizationId',
      );
    }

    const records: ToolDeliveryRecord[] = [];

    try {
      return await this.deliver(command, records);
    } catch (error) {
      // Reaching authoritative state failed, which says nothing about the row.
      // Come back rather than settle it on a guess.
      if (error instanceof RetryDelivery) return { status: 'retry', records };
      throw error;
    }
  }

  private async deliver(
    command: DeliverApprovedToolEffectCommand,
    records: ToolDeliveryRecord[],
  ): Promise<DeliverApprovedToolEffectOutcome> {
    const { toolExecutionId, organizationId } = command;

    const row = await this.executions.loadSideEffect(
      toolExecutionId,
      organizationId,
    );

    if (!row) {
      // The outbox event was committed in the same transaction as the approved
      // row, so this is a payload naming a tenant the row does not belong to,
      // or a row removed by hand. Neither is work for this process.
      records.push({ reason: 'missing' });

      return { status: 'complete', records };
    }

    if (TERMINAL_TOOL_EXECUTION_STATUSES.has(row.status)) {
      records.push({ reason: 'already_settled', status: row.status });

      return { status: 'complete', records };
    }

    if (row.status !== 'APPROVED') {
      // AWAITING_APPROVAL, or STARTED for a row that is not a side effect at
      // all. Nothing here may be performed, and no retry will change that.
      records.push({ reason: 'not_approved', status: row.status });

      return { status: 'complete', records };
    }

    const authorized = await contained(() => this.authorization.authorize(row));

    if (isToolAuthorizationRefusal(authorized)) {
      return this.refuse(row, authorized.refusal, records);
    }

    const prepared = await this.prepare(authorized, row, command);

    if ('failureCode' in prepared) {
      return this.refuse(row, prepared.failureCode, records);
    }

    if (row.effectAttemptCount > 0) {
      const changed = row.effectPayloadDigest !== prepared.payloadDigest;
      const expired =
        row.effectFirstAttemptedAt !== null &&
        Date.now() - row.effectFirstAttemptedAt.getTime() >
          EFFECT_RETRY_WINDOW_MS;

      if (changed || expired) {
        records.push({
          reason: changed ? 'payload_changed' : 'window_expired',
        });

        return this.settle(row, { status: 'OUTCOME_UNKNOWN' }, records);
      }
    }

    const claimed = await contained(() =>
      this.executions.claimEffectAttempt(
        row.id,
        row.organizationId,
        row.effectAttemptCount,
        prepared.payloadDigest,
      ),
    );

    if (!claimed) {
      // Another delivery holds this attempt. Come back later, by which time the
      // row is settled or reclaimable.
      records.push({ reason: 'claim_lost' });

      return { status: 'retry', records };
    }

    let outcome: ExternalEffectOutcome;

    try {
      outcome = await this.delivery.deliver(
        prepared.command,
        idempotencyKeyFor(row),
      );
    } catch {
      // The port answers with a classification and does not throw; a throw is a
      // defect in an adapter, and the only safe reading of it is "unknown".
      outcome = { kind: 'unavailable' };
    }

    switch (outcome.kind) {
      case 'accepted':
        return this.settle(
          row,
          { status: 'SUCCEEDED', providerMessageId: outcome.providerMessageId },
          records,
        );

      case 'rejected':
        return this.refuse(row, 'provider_rejected', records);

      case 'unavailable': {
        // An attempt the provider never answered is not a failure. It is an
        // effect that may or may not have happened, and once no delivery
        // remains that is what the row must say.
        if (command.lastDelivery) {
          records.push({ reason: 'outcome_unknown' });

          return this.settle(row, { status: 'OUTCOME_UNKNOWN' }, records);
        }

        records.push({ reason: 'provider_unavailable' });

        return { status: 'retry', records };
      }
    }
  }

  private async prepare(
    authorized: AuthorizedToolEffect,
    row: SideEffectExecutionRow,
    command: DeliverApprovedToolEffectCommand,
  ): Promise<PreparedEffect | { failureCode: ToolFailureCode }> {
    const context: ToolInvocationContext = {
      organizationId: row.organizationId,
      agentRunId: row.agentRunId,
      agentRunAttempt: row.agentRunAttempt,
      definition: authorized.definition satisfies AgentDefinition,
    };

    try {
      return await authorized.preparer.prepareEffect(row.input, context);
    } catch (error) {
      if (isSideEffectPreconditionError(error)) {
        return { failureCode: error.code };
      }

      if (!command.lastDelivery) throw new RetryDelivery();

      return { failureCode: 'implementation_error' };
    }
  }

  private async refuse(
    row: SideEffectExecutionRow,
    failureCode: ToolFailureCode,
    records: ToolDeliveryRecord[],
  ): Promise<DeliverApprovedToolEffectOutcome> {
    if (row.effectAttemptCount > 0) {
      // An attempt already went out. Whatever the refusal is, the honest state
      // is that nobody knows what the provider did with the first one.
      records.push({ reason: 'refused_after_attempt', failureCode });

      return this.settle(row, { status: 'OUTCOME_UNKNOWN' }, records);
    }

    return this.settle(row, { status: 'FAILED', failureCode }, records);
  }

  private async settle(
    row: SideEffectExecutionRow,
    settlement: EffectSettlement,
    records: ToolDeliveryRecord[],
  ): Promise<DeliverApprovedToolEffectOutcome> {
    const settled = await this.executions.settleEffect(
      row.id,
      row.organizationId,
      settlement,
    );

    records.push({
      reason: settled ? 'settled' : 'settlement_lost',
      status: settlement.status,
      ...(settlement.status === 'FAILED'
        ? { failureCode: settlement.failureCode }
        : {}),
    });

    if (settled) return { status: 'complete', records };

    const current = await this.executions.loadSideEffect(
      row.id,
      row.organizationId,
    );

    if (current && TERMINAL_TOOL_EXECUTION_STATUSES.has(current.status)) {
      return { status: 'complete', records };
    }

    return { status: 'retry', records };
  }
}

/** Thrown internally to unwind to a retry; never escapes `execute`. */
class RetryDelivery extends Error {}

async function contained<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    throw new RetryDelivery();
  }
}

export function idempotencyKeyFor(
  row: Pick<SideEffectExecutionRow, 'id' | 'toolId' | 'toolVersion'>,
): string {
  return `${row.toolId}@${row.toolVersion}:${row.id}`;
}
