import { Injectable } from '@nestjs/common';

import { AppException } from '../../core/errors';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database';
import { OutboxRepository } from '../../infrastructure/outbox';
import {
  APPLICATION_MODEL_CATALOG,
  type AgentModelId,
} from '../models/model-catalog';
import { AgentConfigurationError } from '../agents/agent-configuration.error';
import { AgentDefinitionRegistry } from '../agents/agent-definition.registry';
import {
  AGENT_RUN_DRIVERS,
  MCP_SESSION_RUNTIME,
  TERMINAL_TRANSPORT_FAILURE,
  type AgentFailureDiagnostic,
  type AgentConfiguration,
  type AgentRun,
  type AgentRunStatus,
  type AgentValue,
  type CreateAgentRun,
} from '../agents/agent.types';

const AGENT_RUN_QUEUED = 'agent-run.queued';

export const AGENT_RUN_CAPACITY_LOCK = 4_310_001;

type PersistedAgentRun = Awaited<
  ReturnType<PrismaService['agentRun']['findUniqueOrThrow']>
>;

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    private readonly definitions: AgentDefinitionRegistry,
  ) {}

  async create(input: CreateAgentRun): Promise<AgentRun> {
    const existing = await this.findByIdempotencyKey(input);
    if (existing) return toAgentRun(existing);

    try {
      const run = await this.prisma.$transaction(async (tx) => {
        // Serialize concurrent run requests per tenant to enforce organization
        // concurrency limits atomically without coarse table-level locks.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AGENT_RUN_CAPACITY_LOCK}, hashtext(${input.organizationId}))`;

        const accepted = await tx.agentRun.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });

        if (accepted) return accepted;

        const effective = await this.resolveEffectiveVersion(tx, input);
        await assertCapacity(tx, input);
        const acceptedAt = new Date();
        const pricingRevision = APPLICATION_MODEL_CATALOG.pricingRevision(
          effective.modelId,
          acceptedAt,
        );

        const session = input.driver === AGENT_RUN_DRIVERS.mcpClient;

        const created = await tx.agentRun.create({
          data: {
            agentId: input.agentId,
            agentVersion: effective.definitionVersion,
            runtime: session ? MCP_SESSION_RUNTIME : effective.runtime,
            organizationId: input.organizationId,
            organizationAgentVersionId: effective.id,
            modelPolicyId: effective.modelPolicyId,
            modelId: effective.modelId,
            modelPricingRevisionId: pricingRevision.id,
            createdByUserId: input.createdByUserId,
            input: input.input as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey,
            createdAt: acceptedAt,
            ...(session
              ? {
                  status: 'RUNNING' as const,
                  startedAt: acceptedAt,
                  attemptCount: 1,
                }
              : {}),
          },
        });

        if (!session) {
          await this.outbox.append(tx, {
            type: AGENT_RUN_QUEUED,
            payload: { runId: created.id },
            dedupeKey: created.id,
          });
        }

        return created;
      });

      return toAgentRun(run);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      const winner = await this.findByIdempotencyKey(input);

      // The unique request key makes the first committed run authoritative.
      if (!winner) throw error;

      return toAgentRun(winner);
    }
  }

  async claimExecutionAttempt(
    runId: string,
    attemptsStarted: number,
  ): Promise<AgentRun | null> {
    if (!Number.isInteger(attemptsStarted) || attemptsStarted < 1) {
      throw new Error(
        'Agent execution attempt number must be a positive integer',
      );
    }

    // The BullMQ active-start ordinal is the durable claim's fencing token.
    const queuedClaim = await this.prisma.agentRun.updateManyAndReturn({
      where: {
        id: runId,
        status: 'QUEUED',
        attemptCount: { lt: attemptsStarted },
      },
      data: {
        status: 'RUNNING',
        attemptCount: attemptsStarted,
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
        attemptCount: { lt: attemptsStarted },
      },
      data: {
        attemptCount: attemptsStarted,
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

  private async resolveEffectiveVersion(
    tx: Prisma.TransactionClient,
    input: CreateAgentRun,
  ): Promise<{
    id: string;
    definitionVersion: number;
    runtime: string;
    modelPolicyId: string;
    modelId: AgentModelId;
  }> {
    const installation = await tx.organizationAgentInstallation.findUnique({
      where: {
        organizationId_agentId: {
          organizationId: input.organizationId,
          agentId: input.agentId,
        },
      },
      select: {
        activeVersion: {
          select: {
            id: true,
            definitionVersion: true,
            enabled: true,
            configuration: true,
            modelPolicyId: true,
            modelId: true,
          },
        },
      },
    });

    const active = installation?.activeVersion;
    if (!active) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'organizationAgentInstallation' },
        publicDetails: { reason: 'agent_not_installed' },
      });
    }
    if (!active.enabled) {
      throw new AppException('FEATURE_DISABLED', {
        context: { resource: 'organizationAgentInstallation' },
        publicDetails: { reason: 'agent_disabled' },
      });
    }

    let definition;
    try {
      definition = this.definitions.resolve(
        input.agentId,
        active.definitionVersion,
      );
      this.definitions.parseOrganizationConfiguration(
        input.agentId,
        active.definitionVersion,
        active.configuration,
      );
    } catch (error) {
      if (error instanceof AgentConfigurationError) {
        throw new AppException('NOT_FOUND', {
          context: { resource: 'agentDefinition' },
          publicDetails: { reason: 'agent_definition_unavailable' },
        });
      }
      throw new AppException('CONFLICT', {
        context: { resource: 'organizationAgentConfiguration' },
        publicDetails: { reason: 'invalid_active_configuration' },
      });
    }

    const model = effectiveModelSelection(definition, active);

    return {
      id: active.id,
      definitionVersion: definition.version,
      runtime: definition.runtime,
      modelPolicyId: model.modelPolicyId,
      modelId: model.modelId,
    };
  }

  private findByIdempotencyKey(
    input: Pick<CreateAgentRun, 'organizationId' | 'idempotencyKey'>,
  ) {
    return this.prisma.agentRun.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
  }
}

async function assertCapacity(
  tx: Pick<PrismaService, 'agentRun'>,
  input: CreateAgentRun,
): Promise<void> {
  const { maxInFlight } = input;

  if (maxInFlight === undefined) return;

  const inFlight = await tx.agentRun.count({
    where: {
      organizationId: input.organizationId,
      status: { in: ['QUEUED', 'RUNNING'] },
    },
  });

  if (inFlight < maxInFlight) return;

  throw new AppException('TOO_MANY_REQUESTS', {
    context: { resource: 'agentRun', organizationId: input.organizationId },
    publicDetails: {
      reason:
        'This organization already has the maximum number of agent runs in flight. Wait for one to finish.',
    },
  });
}

function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function toAgentRun(run: PersistedAgentRun): AgentRun {
  return {
    id: run.id,
    agentId: run.agentId,
    agentVersion: run.agentVersion,
    organizationAgentVersionId: run.organizationAgentVersionId,
    modelPolicyId: run.modelPolicyId,
    modelId: run.modelId as AgentModelId | null,
    modelPricingRevisionId: run.modelPricingRevisionId,
    runtime: run.runtime,
    status: run.status,
    organizationId: run.organizationId,
    createdByUserId: run.createdByUserId,
    input: run.input as AgentValue,
    output: run.output as AgentValue | null,
    lastError: run.lastError,
    attemptCount: run.attemptCount,
    idempotencyKey: run.idempotencyKey,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function effectiveModelSelection(
  definition: ReturnType<AgentDefinitionRegistry['resolve']>,
  version: { modelPolicyId: string | null; modelId: string | null },
): { modelPolicyId: string; modelId: AgentModelId } {
  if (version.modelPolicyId === null && version.modelId === null) {
    return {
      modelPolicyId: definition.modelPolicy.id,
      modelId: definition.model,
    };
  }
  if (version.modelPolicyId === null || version.modelId === null) {
    throw invalidActiveModelPolicy();
  }
  if (
    version.modelPolicyId !== definition.modelPolicy.id ||
    !definition.modelPolicy.allowedModelIds.includes(
      version.modelId as AgentModelId,
    )
  ) {
    throw invalidActiveModelPolicy();
  }
  try {
    APPLICATION_MODEL_CATALOG.agentModel(version.modelId);
  } catch {
    throw invalidActiveModelPolicy();
  }
  return {
    modelPolicyId: version.modelPolicyId,
    modelId: version.modelId as AgentModelId,
  };
}

function invalidActiveModelPolicy(): AppException {
  return new AppException('CONFLICT', {
    context: { resource: 'organizationAgentModelPolicy' },
    publicDetails: { reason: 'invalid_active_model_policy' },
  });
}
