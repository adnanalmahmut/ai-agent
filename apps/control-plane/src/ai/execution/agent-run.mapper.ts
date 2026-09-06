import type { PrismaService } from '../../infrastructure/database';
import type { AgentRun, AgentValue } from '../agents/agent.types';
import type { AgentModelId } from '../models/model-catalog';

export type PersistedAgentRun = Awaited<
  ReturnType<PrismaService['agentRun']['findUniqueOrThrow']>
>;

/**
 * The one place a stored row becomes the run the application reasons about.
 * Acceptance and execution live in different modules now, and both must agree
 * on what a run is.
 */
export function toAgentRun(run: PersistedAgentRun): AgentRun {
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
