import { z } from 'zod';

import { AppException } from '../../../core/errors';
import type { ToolExecutionStatus } from '../../../generated/prisma/client';
import type { ToolFailureCode } from '../../../ai/tools/tool.types';

export const AGENT_ACTION_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;

export type AgentActionApprovalStatus =
  (typeof AGENT_ACTION_APPROVAL_STATUSES)[number];

export const agentActionDecisionInput = z
  .object({
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type AgentActionDecisionInput = z.infer<typeof agentActionDecisionInput>;

export const agentActionApprovalQuery = z
  .object({
    status: z.enum(AGENT_ACTION_APPROVAL_STATUSES).optional(),
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

export type AgentActionProposalView = {
  kind: 'notification.send@1';
  recipient: { memberId: string; name: string; email: string } | null;
  subject: string;
  body: string;
};

export type AgentActionApprovalView = {
  toolExecutionId: string;
  organizationId: string;
  agentRunId: string;
  agentId: string;
  agentVersion: number;
  toolId: string;
  toolVersion: number;
  executionStatus: ToolExecutionStatus;
  approval: {
    status: AgentActionApprovalStatus;
    requestedAt: Date;
    decidedAt: Date | null;
    decidedByUserId: string | null;
    decisionNote: string | null;
  };
  proposal: AgentActionProposalView | null;
  effect: {
    attemptCount: number;
    firstAttemptedAt: Date | null;
    completedAt: Date | null;
    failureCode: ToolFailureCode | null;
  };
};

export type AgentActionApprovalPage = {
  items: AgentActionApprovalView[];
  nextCursor: string | null;
};

export const AGENT_ACTION_APPROVAL_PAGE_SIZE = 25;
export const MAX_AGENT_ACTION_APPROVAL_PAGE_SIZE = 100;

export type ApprovalCursor = { requestedAt: Date; id: string };

export function pageSize(requested: number | undefined): number {
  if (requested === undefined) return AGENT_ACTION_APPROVAL_PAGE_SIZE;

  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_AGENT_ACTION_APPROVAL_PAGE_SIZE
  ) {
    throw new AppException('VALIDATION_ERROR', {
      context: { resource: 'agentActionApproval', reason: 'limit' },
      publicDetails: {
        reason: `A page holds between 1 and ${MAX_AGENT_ACTION_APPROVAL_PAGE_SIZE} approvals.`,
      },
    });
  }

  return requested;
}

export function beforePosition(after: ApprovalCursor) {
  return {
    OR: [
      { requestedAt: { lt: after.requestedAt } },
      { requestedAt: after.requestedAt, id: { lt: after.id } },
    ],
  };
}

export function encodeCursor(cursor: ApprovalCursor): string {
  return Buffer.from(
    JSON.stringify({ at: cursor.requestedAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(value: string): ApprovalCursor {
  const invalid = () =>
    new AppException('VALIDATION_ERROR', {
      context: { resource: 'agentActionApproval', reason: 'cursor' },
      publicDetails: { reason: 'The page cursor is not readable.' },
    });

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }

  if (typeof parsed !== 'object' || parsed === null) throw invalid();

  const { at, id } = parsed as Record<string, unknown>;

  if (
    typeof at !== 'string' ||
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 120
  ) {
    throw invalid();
  }

  const requestedAt = new Date(at);
  if (Number.isNaN(requestedAt.getTime())) throw invalid();

  return { requestedAt, id };
}
