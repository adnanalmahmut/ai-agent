import { z } from 'zod';

import { TOOL_FAILURE_CODES } from '../../../ai/tools/tool.types';
import { ToolExecutionStatus } from '../../../generated/prisma/client';
import { isoDateTimeToDate } from '../../../infrastructure/http';

/**
 * The Agent Action Approvals API payload contract. These schemas are the
 * single authored definition of what the endpoints send and accept: the
 * service takes its return types from `z.output`, and the OpenAPI document
 * takes its schemas from `z.input`, so Platform reads the generated form of
 * the same definition rather than a second description of it.
 *
 * Nothing here validates a response at runtime. It defines the contract and
 * types it; the interceptor still serializes whatever a handler returns.
 *
 * This describes what an approver may read and decide. It is not the approval
 * authority: the guards and the service own that, and nothing here changes
 * who may see or decide an action.
 */

/** Where a proposed action stands with its approver. */
export const AGENT_ACTION_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;

export type AgentActionApprovalStatus =
  (typeof AGENT_ACTION_APPROVAL_STATUSES)[number];

/** The execution's own lifecycle, which is wider than the approval decision. */
const toolExecutionStatus = z.enum(ToolExecutionStatus);

export const agentActionProposalSchema = z.object({
  // One proposal kind exists. A second would widen this into a union rather
  // than loosen it into a string.
  kind: z.literal('notification.send@1'),
  // Null where the proposed recipient is no longer a member the caller can be
  // told about.
  recipient: z
    .object({
      memberId: z.string(),
      name: z.string(),
      email: z.string(),
    })
    .nullable(),
  subject: z.string(),
  body: z.string(),
});

export const agentActionApprovalSchema = z.object({
  toolExecutionId: z.string(),
  organizationId: z.string(),
  agentRunId: z.string(),
  agentId: z.string(),
  agentVersion: z.number().int(),
  toolId: z.string(),
  toolVersion: z.number().int(),
  executionStatus: toolExecutionStatus,
  approval: z.object({
    status: z.enum(AGENT_ACTION_APPROVAL_STATUSES),
    requestedAt: isoDateTimeToDate,
    decidedAt: isoDateTimeToDate.nullable(),
    decidedByUserId: z.string().nullable(),
    decisionNote: z.string().nullable(),
  }),
  proposal: agentActionProposalSchema.nullable(),
  // What became of the action once it was approved. Empty of outcome while
  // the decision is still pending.
  effect: z.object({
    attemptCount: z.number().int(),
    firstAttemptedAt: isoDateTimeToDate.nullable(),
    completedAt: isoDateTimeToDate.nullable(),
    failureCode: z.enum(TOOL_FAILURE_CODES).nullable(),
  }),
});

/**
 * Cursor pagination, which is not the envelope's `page`/`perPage` metadata:
 * the interceptor only lifts pagination out of a payload that carries a
 * `pagination` key, so this whole object is the response `data`.
 */
export const agentActionApprovalPageSchema = z.object({
  items: z.array(agentActionApprovalSchema),
  nextCursor: z.string().nullable(),
});
