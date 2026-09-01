import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database';
import { Prisma } from '../../generated/prisma/client';
import type { AgentValue } from '../agent.types';
import type { ToolFailureCode } from './tool.types';

/**
 * The durable half of tool execution.
 *
 * Three narrow writes rather than a repository: a tool execution has exactly
 * one lifecycle and it is linear, so anything more general would be a shape
 * invented for callers that do not exist.
 *
 * There is deliberately no reconciler. A read-only execution left `STARTED` by
 * a process death is an honest "outcome unknown" for an operation that changed
 * nothing outside this system, and inventing a sweep to force such rows
 * terminal would be guessing at history. An external side effect is a
 * genuinely different problem and belongs to the change that introduces one.
 */
@Injectable()
export class ToolExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records the attempt before the implementation runs.
   *
   * Written after authority, grant, and input validation and before the call,
   * so a row existing means "this was permitted and was handed over" and never
   * "this was asked for". A refused call leaves no row at all, which is what
   * keeps a denial from looking like a failed execution.
   */
  async start(input: {
    organizationId: string;
    agentRunId: string;
    agentRunAttempt: number;
    toolId: string;
    toolVersion: number;
    /** As the application parsed it, never as the caller sent it. */
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

  /**
   * The result, already parsed by the tool's own output schema.
   *
   * Scoped by `(id, organizationId)` rather than by id alone. The id is a uuid
   * this service just minted and never hands out, so the predicate cannot
   * matter today — but the schema's whole argument for the composite foreign
   * key is that a service predicate is one forgotten `where` clause away from
   * absent, and an update carrying no tenant is that clause missing.
   */
  async succeed(
    id: string,
    organizationId: string,
    output: AgentValue,
  ): Promise<void> {
    await this.prisma.toolExecution.updateMany({
      where: { id, organizationId },
      data: {
        status: 'SUCCEEDED',
        output: asJson(output),
        completedAt: new Date(),
      },
    });
  }

  /**
   * A closed application-owned code and nothing else.
   *
   * The parameter type is the union, not `string`, so a future caller cannot
   * reach for `error.message` here without first widening a type that exists
   * to be hard to widen.
   */
  async fail(
    id: string,
    organizationId: string,
    failureCode: ToolFailureCode,
  ): Promise<void> {
    await this.prisma.toolExecution.updateMany({
      where: { id, organizationId },
      data: { status: 'FAILED', failureCode, completedAt: new Date() },
    });
  }
}

function asJson(value: AgentValue): Prisma.InputJsonValue {
  return (value ?? Prisma.JsonNull) as Prisma.InputJsonValue;
}
