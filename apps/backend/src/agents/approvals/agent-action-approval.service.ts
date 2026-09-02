import { Injectable } from '@nestjs/common';

import { AppException } from '../../core/errors';
import { OutboxRepository } from '../../core/outbox';
import { PrismaService } from '../../database';
import type { Prisma } from '../../generated/prisma/client';
import { OrganizationAuditService } from '../../organization-audit';
import { notificationSendInput } from '../tools/definitions/notification-send';
import {
  beforePosition,
  decodeCursor,
  encodeCursor,
  pageSize,
  type AgentActionApprovalPage,
  type AgentActionApprovalStatus,
  type AgentActionApprovalView,
  type AgentActionProposalView,
} from './agent-action-approval.types';

const TOOL_EXECUTION_APPROVED = 'tool-execution.approved';

const approvalSelect = {
  id: true,
  status: true,
  requestedAt: true,
  decidedAt: true,
  decidedByUserId: true,
  decisionNote: true,
  toolExecution: {
    select: {
      id: true,
      organizationId: true,
      agentRunId: true,
      toolId: true,
      toolVersion: true,
      status: true,
      input: true,
      effectAttemptCount: true,
      effectFirstAttemptedAt: true,
      completedAt: true,
      failureCode: true,
      agentRun: { select: { agentId: true, agentVersion: true } },
    },
  },
} as const;

type ApprovalRow = Prisma.ToolExecutionApprovalGetPayload<{
  select: typeof approvalSelect;
}>;

/**
 * Human approval of proposed agent actions: the read surface and the two
 * decisions.
 *
 * Both decisions are compare-and-set transitions on two rows in one
 * transaction — the approval leaves `PENDING`, the execution leaves
 * `AWAITING_APPROVAL` — and each requires exactly one row to have moved. A
 * second approver, a concurrent rejection, or a replayed request matches
 * nothing and is refused with `CONFLICT`, never merged and never overwritten.
 * For an approval the outbox event that will perform the effect is written in
 * the same transaction, so "approved" and "queued to perform" are one fact.
 *
 * Authorization is not here. It is the shared organization guard on the
 * controller, which runs before the body is parsed and answers about the
 * organization in the path. This service trusts `organizationId` only as a
 * predicate: every read and write carries it, so an execution id from another
 * tenant finds nothing.
 */
@Injectable()
export class AgentActionApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    private readonly audit: OrganizationAuditService,
  ) {}

  async list(input: {
    organizationId: string;
    status?: AgentActionApprovalStatus;
    cursor?: string;
    limit?: number;
  }): Promise<AgentActionApprovalPage> {
    const take = pageSize(input.limit);
    const after =
      input.cursor === undefined ? null : decodeCursor(input.cursor);

    const rows = await this.prisma.toolExecutionApproval.findMany({
      where: {
        organizationId: input.organizationId,
        ...(input.status ? { status: input.status } : {}),
        ...(after ? beforePosition(after) : {}),
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      select: approvalSelect,
    });

    const page = rows.slice(0, take);
    const last = rows.length > take ? page.at(-1) : undefined;

    return {
      items: await this.project(input.organizationId, page),
      nextCursor: last
        ? encodeCursor({ requestedAt: last.requestedAt, id: last.id })
        : null,
    };
  }

  async detail(input: {
    organizationId: string;
    toolExecutionId: string;
  }): Promise<AgentActionApprovalView> {
    const row = await this.prisma.toolExecutionApproval.findFirst({
      where: {
        toolExecutionId: input.toolExecutionId,
        organizationId: input.organizationId,
      },
      select: approvalSelect,
    });

    if (!row) throw notFound();

    const [view] = await this.project(input.organizationId, [row]);

    return view;
  }

  approve(input: DecisionInput): Promise<AgentActionApprovalView> {
    return this.decide(input, 'approved');
  }

  reject(input: DecisionInput): Promise<AgentActionApprovalView> {
    return this.decide(input, 'rejected');
  }

  /**
   * One decision, as one transaction.
   *
   * The approval row moves first, because it is the row that carries the
   * unique constraint and therefore the row two concurrent deciders contend
   * on: under READ COMMITTED the second `UPDATE` waits for the first to
   * commit, re-evaluates `status = PENDING`, matches nothing, and is refused.
   * The execution row moves second under its own predicate; a mismatch there
   * means the two rows disagree about the world and the whole transaction
   * rolls back rather than record half a decision.
   */
  private async decide(
    input: DecisionInput,
    decision: 'approved' | 'rejected',
  ): Promise<AgentActionApprovalView> {
    const decidedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.toolExecutionApproval.updateMany({
        where: {
          toolExecutionId: input.toolExecutionId,
          organizationId: input.organizationId,
          status: 'PENDING',
        },
        data: {
          status: decision === 'approved' ? 'APPROVED' : 'REJECTED',
          decidedAt,
          decidedByUserId: input.actorUserId,
          decisionNote: input.note ?? null,
        },
      });

      if (moved.count !== 1) {
        throw await this.refusal(tx, input);
      }

      const execution = await tx.toolExecution.findFirst({
        where: {
          id: input.toolExecutionId,
          organizationId: input.organizationId,
        },
        select: { agentRunId: true, toolId: true, toolVersion: true },
      });

      const executionMoved = await tx.toolExecution.updateMany({
        where: {
          id: input.toolExecutionId,
          organizationId: input.organizationId,
          status: 'AWAITING_APPROVAL',
        },
        data:
          decision === 'approved'
            ? { status: 'APPROVED' }
            : { status: 'REJECTED', completedAt: decidedAt },
      });

      if (!execution || executionMoved.count !== 1) {
        throw new AppException('CONFLICT', {
          context: {
            resource: 'agentActionApproval',
            reason: 'execution_not_awaiting_approval',
          },
          publicDetails: { reason: 'already_decided' },
        });
      }

      if (decision === 'approved') {
        await this.outbox.append(tx, {
          type: TOOL_EXECUTION_APPROVED,
          payload: {
            toolExecutionId: input.toolExecutionId,
            organizationId: input.organizationId,
          },
          dedupeKey: input.toolExecutionId,
        });
      }

      await this.audit.recordAgentActionDecision(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        toolExecutionId: input.toolExecutionId,
        agentRunId: execution.agentRunId,
        toolId: execution.toolId,
        toolVersion: execution.toolVersion,
        decision,
      });
    });

    return this.detail(input);
  }

  /**
   * Why a decision matched nothing: no such proposal here, or one already
   * decided. A proposal in another organization is the former — the predicate
   * carried the tenant, so it is indistinguishable from one that does not
   * exist, which is the only answer a non-member may receive.
   */
  private async refusal(
    tx: Prisma.TransactionClient,
    input: DecisionInput,
  ): Promise<AppException> {
    const existing = await tx.toolExecutionApproval.findFirst({
      where: {
        toolExecutionId: input.toolExecutionId,
        organizationId: input.organizationId,
      },
      select: { status: true },
    });

    if (!existing) return notFound();

    return new AppException('CONFLICT', {
      context: { resource: 'agentActionApproval', status: existing.status },
      publicDetails: { reason: 'already_decided' },
    });
  }

  /**
   * Rows to views, with the recipient resolved against the organization.
   *
   * One membership query for the page rather than one per row. A member id
   * that no longer resolves *in this organization* yields `null`, and a row
   * whose input no longer parses as its tool's input — which cannot happen
   * through the gateway — yields no proposal at all rather than a guess.
   */
  private async project(
    organizationId: string,
    rows: readonly ApprovalRow[],
  ): Promise<AgentActionApprovalView[]> {
    const proposals = rows.map((row) => proposalOf(row));
    const memberIds = [
      ...new Set(
        proposals.flatMap((proposal) =>
          proposal ? [proposal.recipientMemberId] : [],
        ),
      ),
    ];

    const members =
      memberIds.length === 0
        ? []
        : await this.prisma.member.findMany({
            where: { id: { in: memberIds }, organizationId },
            select: {
              id: true,
              user: { select: { name: true, email: true } },
            },
          });
    const byId = new Map(members.map((member) => [member.id, member]));

    return rows.map((row, index) => {
      const proposal = proposals[index];
      const execution = row.toolExecution;

      return {
        toolExecutionId: execution.id,
        organizationId: execution.organizationId,
        agentRunId: execution.agentRunId,
        agentId: execution.agentRun.agentId,
        agentVersion: execution.agentRun.agentVersion,
        toolId: execution.toolId,
        toolVersion: execution.toolVersion,
        executionStatus: execution.status,
        approval: {
          status: row.status,
          requestedAt: row.requestedAt,
          decidedAt: row.decidedAt,
          decidedByUserId: row.decidedByUserId,
          decisionNote: row.decisionNote,
        },
        proposal: proposal
          ? {
              kind: 'notification.send@1',
              recipient: (() => {
                const member = byId.get(proposal.recipientMemberId);
                return member
                  ? {
                      memberId: member.id,
                      name: member.user.name,
                      email: member.user.email,
                    }
                  : null;
              })(),
              subject: proposal.subject,
              body: proposal.body,
            }
          : null,
        effect: {
          attemptCount: execution.effectAttemptCount,
          firstAttemptedAt: execution.effectFirstAttemptedAt,
          completedAt: execution.completedAt,
          failureCode: execution.failureCode,
        },
      } satisfies AgentActionApprovalView;
    });
  }
}

type DecisionInput = {
  organizationId: string;
  toolExecutionId: string;
  actorUserId: string;
  note?: string;
};

/**
 * The stored input, re-parsed through the tool's own schema.
 *
 * Only one side-effect tool exists, so this is a check rather than a
 * dispatch. A second tool makes it a `switch` on `toolId@toolVersion`, and the
 * view type gains a second `kind`.
 */
function proposalOf(row: ApprovalRow): {
  recipientMemberId: string;
  subject: string;
  body: string;
} | null {
  const { toolId, toolVersion, input } = row.toolExecution;

  if (toolId !== 'notification.send' || toolVersion !== 1) return null;

  const parsed = notificationSendInput.safeParse(input);

  return parsed.success ? parsed.data : null;
}

function notFound(): AppException {
  return new AppException('NOT_FOUND', {
    context: { resource: 'agentActionApproval' },
  });
}

export type { AgentActionProposalView };
