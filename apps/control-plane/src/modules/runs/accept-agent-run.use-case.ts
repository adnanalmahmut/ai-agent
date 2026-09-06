import { Injectable } from '@nestjs/common';

import { AgentConfigurationError } from '../../ai/agents/agent-configuration.error';
import { AgentDefinitionRegistry } from '../../ai/agents/agent-definition.registry';
import {
  AGENT_RUN_DRIVERS,
  MCP_SESSION_RUNTIME,
  type AgentRun,
  type CreateAgentRun,
} from '../../ai/agents/agent.types';
import { toAgentRun } from '../../ai/execution/agent-run.mapper';
import {
  APPLICATION_MODEL_CATALOG,
  type AgentModelId,
} from '../../ai/models/model-catalog';
import { AppException } from '../../core/errors';
import { Prisma } from '../../generated/prisma/client';
import {
  isUniqueConstraintViolation,
  PrismaService,
} from '../../infrastructure/database';
// The writer, not the module surface: accepting a run appends to the outbox,
// and has no business reaching the dispatcher that later drains it.
import { OutboxRepository } from '../../infrastructure/outbox/outbox.repository';

const AGENT_RUN_QUEUED = 'agent-run.queued';

export const AGENT_RUN_CAPACITY_LOCK = 4_310_001;

export type AcceptAgentRunCommand = CreateAgentRun;

/**
 * Deciding that a run exists, and what it will execute against.
 *
 * Everything the run is pinned to is settled here, before any transport knows
 * the run exists: the installed agent version, the model policy and model, the
 * pricing revision, and the caller's request key. A queue delivery later on
 * carries an identifier and an attempt ordinal — never a version or a policy,
 * because by then those are durable facts rather than open questions.
 *
 * Publishing is deliberately not part of accepting. The transactional outbox
 * commits with the run, so a broker that is unreachable afterwards delays
 * delivery instead of retracting an acceptance the caller was already told
 * about.
 */
@Injectable()
export class AcceptAgentRunUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    private readonly definitions: AgentDefinitionRegistry,
  ) {}

  async execute(command: AcceptAgentRunCommand): Promise<AgentRun> {
    const existing = await this.findByIdempotencyKey(command);
    if (existing) return toAgentRun(existing);

    try {
      const run = await this.prisma.$transaction(async (tx) => {
        // Serialize concurrent run requests per tenant to enforce organization
        // concurrency limits atomically without coarse table-level locks.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AGENT_RUN_CAPACITY_LOCK}, hashtext(${command.organizationId}))`;

        const accepted = await tx.agentRun.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: command.organizationId,
              idempotencyKey: command.idempotencyKey,
            },
          },
        });

        if (accepted) return accepted;

        const effective = await this.resolveEffectiveVersion(tx, command);
        await assertCapacity(tx, command);
        const acceptedAt = new Date();
        const pricingRevision = APPLICATION_MODEL_CATALOG.pricingRevision(
          effective.modelId,
          acceptedAt,
        );

        const session = command.driver === AGENT_RUN_DRIVERS.mcpClient;

        const created = await tx.agentRun.create({
          data: {
            agentId: command.agentId,
            agentVersion: effective.definitionVersion,
            runtime: session ? MCP_SESSION_RUNTIME : effective.runtime,
            organizationId: command.organizationId,
            organizationAgentVersionId: effective.id,
            modelPolicyId: effective.modelPolicyId,
            modelId: effective.modelId,
            modelPricingRevisionId: pricingRevision.id,
            createdByUserId: command.createdByUserId,
            input: command.input as Prisma.InputJsonValue,
            idempotencyKey: command.idempotencyKey,
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

      const winner = await this.findByIdempotencyKey(command);

      // The unique request key makes the first committed run authoritative.
      if (!winner) throw error;

      return toAgentRun(winner);
    }
  }

  private async resolveEffectiveVersion(
    tx: Prisma.TransactionClient,
    command: AcceptAgentRunCommand,
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
          organizationId: command.organizationId,
          agentId: command.agentId,
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
        command.agentId,
        active.definitionVersion,
      );
      this.definitions.parseOrganizationConfiguration(
        command.agentId,
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
    command: Pick<AcceptAgentRunCommand, 'organizationId' | 'idempotencyKey'>,
  ) {
    return this.prisma.agentRun.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: command.organizationId,
          idempotencyKey: command.idempotencyKey,
        },
      },
    });
  }
}

async function assertCapacity(
  tx: Pick<PrismaService, 'agentRun'>,
  command: AcceptAgentRunCommand,
): Promise<void> {
  const { maxInFlight } = command;

  if (maxInFlight === undefined) return;

  const inFlight = await tx.agentRun.count({
    where: {
      organizationId: command.organizationId,
      status: { in: ['QUEUED', 'RUNNING'] },
    },
  });

  if (inFlight < maxInFlight) return;

  throw new AppException('TOO_MANY_REQUESTS', {
    context: { resource: 'agentRun', organizationId: command.organizationId },
    publicDetails: {
      reason:
        'This organization already has the maximum number of agent runs in flight. Wait for one to finish.',
    },
  });
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
