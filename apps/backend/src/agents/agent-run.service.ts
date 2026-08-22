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

  /**
   * Atomically claims exactly the BullMQ attempt currently being delivered.
   *
   * The attempt counter stores BullMQ's active-start ordinal as the claim
   * version. A duplicate delivery can observe the same/newer version but cannot
   * claim it or execute the runtime again. Unlike attemptsMade, that ordinal
   * also advances when BullMQ recovers a stalled job after worker death.
   */
  async claimExecutionAttempt(
    runId: string,
    attemptsStarted: number,
  ): Promise<AgentRun | null> {
    if (!Number.isInteger(attemptsStarted) || attemptsStarted < 1) {
      throw new Error(
        'Agent execution attempt number must be a positive integer',
      );
    }

    // A worker may stall before it reaches this transaction. Any active
    // delivery can therefore be the first durable claim, and its BullMQ start
    // ordinal becomes the CAS version without inventing a lease system here.
    const queuedClaim = await this.prisma.agentRun.updateManyAndReturn({
      where: {
        id: runId,
        status: 'QUEUED',
        attemptCount: 0,
      },
      data: {
        status: 'RUNNING',
        attemptCount: attemptsStarted,
        lastError: null,
        startedAt: new Date(),
      },
    });

    if (queuedClaim[0]) return toAgentRun(queuedClaim[0]);

    const runningClaim = await this.prisma.agentRun.updateManyAndReturn({
      where: {
        id: runId,
        status: 'RUNNING',
        attemptCount: attemptsStarted - 1,
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

    if (current.status === 'SUCCEEDED' || current.status === 'FAILED') {
      return null;
    }

    // Another delivery already claimed this attempt. It owns the model call.
    if (
      current.status === 'RUNNING' &&
      current.attemptCount >= attemptsStarted
    ) {
      return null;
    }

    throw new Error(
      `AgentRun "${runId}" cannot claim queue start ${attemptsStarted}`,
    );
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
        output:
          output === null ? Prisma.JsonNull : (output as Prisma.InputJsonValue),
        lastError: null,
        completedAt: new Date(),
      },
    });

    return count === 1;
  }

  async recordExecutionFailure(
    runId: string,
    attemptCount: number,
    lastError: string,
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

function toAgentRun(run: PersistedAgentRun): AgentRun {
  return {
    ...run,
    input: run.input as AgentValue,
    output: run.output as AgentValue | null,
  };
}
