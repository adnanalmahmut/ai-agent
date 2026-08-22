import { Injectable } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../database';
import { OutboxRepository } from '../core/outbox';
import type { AgentRun, AgentValue, CreateAgentRun } from './agent.types';

const AGENT_RUN_QUEUED = 'agent-run.queued';

type PersistedAgentRun = Awaited<
  ReturnType<PrismaService['agentRun']['findUniqueOrThrow']>
>;

/** Internal acceptance boundary for durable background agent work. */
@Injectable()
export class AgentRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
  ) {}

  /**
   * Commits the run and its queue intent together.
   *
   * Authorization is intentionally not performed here: this slice has no HTTP
   * operation. A future real-agent feature must authorize before calling this
   * internal service and must supply a registered definition/runtime pair.
   */
  async create(input: CreateAgentRun): Promise<AgentRun> {
    const existing = await this.findByIdempotencyKey(input);
    if (existing) return toAgentRun(existing);

    try {
      const run = await this.prisma.$transaction(async (tx) => {
        const created = await tx.agentRun.create({
          data: {
            agentId: input.agentId,
            agentVersion: input.agentVersion,
            runtime: input.runtime,
            organizationId: input.organizationId,
            createdByUserId: input.createdByUserId,
            input: input.input as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey,
          },
        });

        await this.outbox.append(tx, {
          type: AGENT_RUN_QUEUED,
          payload: { runId: created.id },
          dedupeKey: created.id,
        });

        return created;
      });

      return toAgentRun(run);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      const winner = await this.findByIdempotencyKey(input);

      // A P2002 on this insert can only be the durable idempotency constraint.
      // Still fail loudly if the winning row cannot be observed instead of
      // manufacturing a success response with no durable authority behind it.
      if (!winner) throw error;

      return toAgentRun(winner);
    }
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

function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Mapped field by field rather than spread. A spread is not excess-property
 * checked, so every column the Prisma model gains would silently become part
 * of the application-owned contract this module exists to keep separate.
 */
function toAgentRun(run: PersistedAgentRun): AgentRun {
  return {
    id: run.id,
    agentId: run.agentId,
    agentVersion: run.agentVersion,
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
