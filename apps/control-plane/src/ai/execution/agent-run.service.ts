import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database';
import { AgentConfigurationError } from '../agents/agent-configuration.error';
import {
  MCP_SESSION_RUNTIME,
  TERMINAL_TRANSPORT_FAILURE,
  type AgentConfiguration,
  type AgentFailureDiagnostic,
  type AgentRun,
  type AgentRunStatus,
  type AgentValue,
} from '../agents/agent.types';
import { toAgentRun } from './agent-run.mapper';

export type StaleRunCursor = { updatedAt: Date; id: string };

export type StaleAgentRun = {
  id: string;
  status: AgentRunStatus;
  attemptCount: number;
  updatedAt: Date;
  runtime: string;
  createdAt: Date;
  organizationId: string;
};

@Injectable()
export class AgentRunService {
  constructor(private readonly prisma: PrismaService) {}

  async claimExecutionAttempt(
    runId: string,
    attempt: number,
  ): Promise<AgentRun | null> {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new Error(
        'Agent execution attempt number must be a positive integer',
      );
    }

    // The caller's delivery ordinal is the durable claim's fencing token.
    const queuedClaim = await this.prisma.agentRun.updateManyAndReturn({
      where: {
        id: runId,
        status: 'QUEUED',
        attemptCount: { lt: attempt },
      },
      data: {
        status: 'RUNNING',
        attemptCount: attempt,
        lastError: null,
        startedAt: new Date(),
      },
    });

    if (queuedClaim[0]) return toAgentRun(queuedClaim[0]);

    // Ordinals may skip if a worker dies after activation but before this write.
    const runningClaim = await this.prisma.agentRun.updateManyAndReturn({
      where: {
        id: runId,
        status: 'RUNNING',
        attemptCount: { lt: attempt },
      },
      data: {
        attemptCount: attempt,
        lastError: null,
      },
    });

    if (runningClaim[0]) return toAgentRun(runningClaim[0]);

    const current = await this.prisma.agentRun.findUnique({
      where: { id: runId },
    });

    if (!current) throw new Error(`AgentRun "${runId}" does not exist`);

    // Terminal, stale, and duplicate deliveries cannot reclaim work.
    return null;
  }

  async markExecutionSucceeded(
    runId: string,
    attemptCount: number,
    output: AgentValue,
  ): Promise<boolean> {
    const { count } = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: 'RUNNING', attemptCount },
      data: {
        status: 'SUCCEEDED',
        // Prisma omits undefined fields, so require an explicit result value.
        output:
          output == null ? Prisma.JsonNull : (output as Prisma.InputJsonValue),
        lastError: null,
        completedAt: new Date(),
      },
    });

    return count === 1;
  }

  async recordExecutionFailure(
    runId: string,
    attemptCount: number,
    lastError: AgentFailureDiagnostic,
    final: boolean,
  ): Promise<boolean> {
    const { count } = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: 'RUNNING', attemptCount },
      data: final
        ? {
            status: 'FAILED',
            lastError,
            completedAt: new Date(),
          }
        : { lastError },
    });

    return count === 1;
  }

  findStaleNonTerminal(
    staleBefore: Date,
    limit: number,
    after?: StaleRunCursor,
  ): Promise<StaleAgentRun[]> {
    return this.prisma.agentRun.findMany({
      where: {
        status: { in: ['QUEUED', 'RUNNING'] },
        updatedAt: { lt: staleBefore },
        // ID breaks timestamp ties so reconciliation cannot skip rows.
        ...(after
          ? {
              OR: [
                { updatedAt: { gt: after.updatedAt } },
                { updatedAt: after.updatedAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        status: true,
        attemptCount: true,
        updatedAt: true,
        runtime: true,
        createdAt: true,
        organizationId: true,
      },
    });
  }

  findMcpSession(input: { id: string; organizationId: string }): Promise<{
    id: string;
    agentId: string;
    agentVersion: number;
    organizationAgentVersionId: string | null;
    organizationId: string;
    status: AgentRunStatus;
    createdByUserId: string | null;
    createdAt: Date;
  } | null> {
    return this.prisma.agentRun.findFirst({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        runtime: MCP_SESSION_RUNTIME,
      },
      select: {
        id: true,
        agentId: true,
        agentVersion: true,
        organizationAgentVersionId: true,
        organizationId: true,
        status: true,
        createdByUserId: true,
        createdAt: true,
      },
    });
  }

  async closeMcpSession(input: {
    id: string;
    organizationId: string;
    closedBy: 'client' | 'expiry';
  }): Promise<boolean> {
    const closedAt = new Date();

    const { count } = await this.prisma.agentRun.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        runtime: MCP_SESSION_RUNTIME,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      data: {
        status: 'SUCCEEDED',
        completedAt: closedAt,
        output: { closedBy: input.closedBy },
      },
    });

    return count === 1;
  }

  async reconcileTerminalFailure(runId: string): Promise<boolean> {
    const { count } = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        lastError: TERMINAL_TRANSPORT_FAILURE,
        completedAt: new Date(),
      },
    });

    return count === 1;
  }

  /**
   * The run as durable state has it, with no tenant supplied by the caller.
   *
   * Callers that were given a run id by something other than a session use
   * this and then compare: the organization a run belongs to is read here, not
   * accepted from whoever is asking.
   */
  async findById(runId: string): Promise<AgentRun | null> {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });

    return run === null ? null : toAgentRun(run);
  }

  async findForOrganization(input: {
    runId: string;
    organizationId: string;
  }): Promise<AgentRun | null> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: input.runId, organizationId: input.organizationId },
    });

    return run === null ? null : toAgentRun(run);
  }

  async installationAvailability(input: {
    organizationId: string;
    agentId: string;
  }): Promise<'agent_not_installed' | 'agent_disabled' | null> {
    const installation =
      await this.prisma.organizationAgentInstallation.findUnique({
        where: {
          organizationId_agentId: {
            organizationId: input.organizationId,
            agentId: input.agentId,
          },
        },
        select: { activeVersion: { select: { enabled: true } } },
      });

    if (!installation?.activeVersion) return 'agent_not_installed';
    return installation.activeVersion.enabled ? null : 'agent_disabled';
  }

  async pinnedVersionFor(
    run: Pick<
      AgentRun,
      | 'organizationAgentVersionId'
      | 'organizationId'
      | 'agentId'
      | 'agentVersion'
    >,
  ): Promise<{
    configuration: AgentConfiguration;
    toolGrants: readonly string[];
  } | null> {
    if (run.organizationAgentVersionId === null) return null;

    const version = await this.prisma.organizationAgentVersion.findFirst({
      where: {
        id: run.organizationAgentVersionId,
        organizationId: run.organizationId,
        definitionVersion: run.agentVersion,
        installation: {
          organizationId: run.organizationId,
          agentId: run.agentId,
        },
      },
      select: { configuration: true, toolGrants: true },
    });

    if (!version) {
      throw new AgentConfigurationError(
        'AgentRun organization version does not match its durable identity',
      );
    }

    return {
      configuration: version.configuration as AgentConfiguration,
      toolGrants: version.toolGrants,
    };
  }
}
