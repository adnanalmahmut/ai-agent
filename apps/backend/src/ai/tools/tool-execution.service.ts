import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/database';
import {
  Prisma,
  type ToolExecutionApprovalStatus,
  type ToolExecutionStatus,
} from '../../generated/prisma/client';
import type { AgentValue } from '../agents/agent.types';
import { digestValue } from './digest';
import type { ToolFailureCode } from './tool.types';

export const TERMINAL_TOOL_EXECUTION_STATUSES = new Set<string>([
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
  'OUTCOME_UNKNOWN',
]);

export type SideEffectExecutionRow = {
  id: string;
  organizationId: string;
  agentRunId: string;
  agentRunAttempt: number;
  toolId: string;
  toolVersion: number;
  status: ToolExecutionStatus;
  input: AgentValue;
  effectAttemptCount: number;
  effectFirstAttemptedAt: Date | null;
  effectPayloadDigest: string | null;
  approval: { status: ToolExecutionApprovalStatus; inputDigest: string } | null;
  agentRun: {
    agentId: string;
    agentVersion: number;
    organizationAgentVersionId: string | null;
  };
};

export type EffectSettlement =
  | { status: 'SUCCEEDED'; providerMessageId: string }
  | { status: 'FAILED'; failureCode: ToolFailureCode }
  | { status: 'OUTCOME_UNKNOWN' };

@Injectable()
export class ToolExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  async start(input: {
    organizationId: string;
    agentRunId: string;
    agentRunAttempt: number;
    toolId: string;
    toolVersion: number;
    input: AgentValue;
  }): Promise<string> {
    const row = await this.prisma.toolExecution.create({
      data: {
        organizationId: input.organizationId,
        agentRunId: input.agentRunId,
        agentRunAttempt: input.agentRunAttempt,
        toolId: input.toolId,
        toolVersion: input.toolVersion,
        status: 'STARTED',
        input: asJson(input.input),
      },
      select: { id: true },
    });

    return row.id;
  }

  async succeed(
    id: string,
    organizationId: string,
    output: AgentValue,
  ): Promise<void> {
    await this.transition(id, organizationId, 'SUCCEEDED', {
      output: asJson(output),
    });
  }

  async fail(
    id: string,
    organizationId: string,
    failureCode: ToolFailureCode,
  ): Promise<void> {
    await this.transition(id, organizationId, 'FAILED', { failureCode });
  }

  private async transition(
    id: string,
    organizationId: string,
    status: 'SUCCEEDED' | 'FAILED',
    data: Omit<Prisma.ToolExecutionUpdateManyMutationInput, 'status'>,
  ): Promise<void> {
    const { count } = await this.prisma.toolExecution.updateMany({
      where: { id, organizationId, status: 'STARTED' },
      data: { ...data, status, completedAt: new Date() },
    });

    if (count !== 1) {
      throw new ToolExecutionTransitionError(
        `ToolExecution "${id}" could not transition to ${status}`,
      );
    }
  }

  async propose(input: {
    organizationId: string;
    agentRunId: string;
    agentRunAttempt: number;
    toolId: string;
    toolVersion: number;
    input: AgentValue;
  }): Promise<string> {
    const inputDigest = digestValue(input.input);

    return this.prisma.$transaction(async (tx) => {
      const execution = await tx.toolExecution.create({
        data: {
          organizationId: input.organizationId,
          agentRunId: input.agentRunId,
          agentRunAttempt: input.agentRunAttempt,
          toolId: input.toolId,
          toolVersion: input.toolVersion,
          status: 'AWAITING_APPROVAL',
          input: asJson(input.input),
        },
        select: { id: true },
      });

      await tx.toolExecutionApproval.create({
        data: {
          organizationId: input.organizationId,
          toolExecutionId: execution.id,
          status: 'PENDING',
          inputDigest,
        },
      });

      return execution.id;
    });
  }

  countForRun(agentRunId: string, organizationId: string): Promise<number> {
    return this.prisma.toolExecution.count({
      where: { agentRunId, organizationId },
    });
  }

  async loadSideEffect(
    id: string,
    organizationId: string,
  ): Promise<SideEffectExecutionRow | null> {
    const row = await this.prisma.toolExecution.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        organizationId: true,
        agentRunId: true,
        agentRunAttempt: true,
        toolId: true,
        toolVersion: true,
        status: true,
        input: true,
        effectAttemptCount: true,
        effectFirstAttemptedAt: true,
        effectPayloadDigest: true,
        approval: { select: { status: true, inputDigest: true } },
        agentRun: {
          select: {
            agentId: true,
            agentVersion: true,
            organizationAgentVersionId: true,
          },
        },
      },
    });

    if (!row) return null;

    return { ...row, input: row.input as AgentValue };
  }

  async claimEffectAttempt(
    id: string,
    organizationId: string,
    expectedAttempts: number,
    payloadDigest: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.toolExecution.updateMany({
      where: {
        id,
        organizationId,
        status: 'APPROVED',
        effectAttemptCount: expectedAttempts,
      },
      data: {
        effectAttemptCount: expectedAttempts + 1,
        ...(expectedAttempts === 0
          ? {
              effectFirstAttemptedAt: new Date(),
              effectPayloadDigest: payloadDigest,
            }
          : {}),
      },
    });

    return count === 1;
  }

  async settleEffect(
    id: string,
    organizationId: string,
    settlement: EffectSettlement,
  ): Promise<boolean> {
    const data: Prisma.ToolExecutionUpdateManyMutationInput =
      settlement.status === 'SUCCEEDED'
        ? {
            status: 'SUCCEEDED',
            providerMessageId: settlement.providerMessageId,
            output: asJson({ status: 'sent' }),
          }
        : settlement.status === 'FAILED'
          ? { status: 'FAILED', failureCode: settlement.failureCode }
          : { status: 'OUTCOME_UNKNOWN' };

    const { count } = await this.prisma.toolExecution.updateMany({
      where: { id, organizationId, status: 'APPROVED' },
      data: { ...data, completedAt: new Date() },
    });

    return count === 1;
  }
}

export class ToolExecutionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionTransitionError';
  }
}

function asJson(value: AgentValue): Prisma.InputJsonValue {
  return (value ?? Prisma.JsonNull) as Prisma.InputJsonValue;
}
