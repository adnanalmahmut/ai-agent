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
 * The lifecycle is `STARTED -> SUCCEEDED | FAILED`, and it is enforced here
 * rather than merely described. See `transition`.
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
    await this.transition(id, organizationId, 'SUCCEEDED', {
      output: asJson(output),
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
    await this.transition(id, organizationId, 'FAILED', { failureCode });
  }

  /**
   * The only way a row leaves `STARTED`, as one compare-and-set.
   *
   * `status: 'STARTED'` is in the `where`, not assumed from the caller having
   * just written it. Without it the two terminal writes are unconditional
   * updates to a row addressed by primary key, which is not a state machine:
   * `FAILED -> SUCCEEDED` and `SUCCEEDED -> FAILED` both succeed, and history
   * ends up recording whichever caller wrote last rather than what happened
   * first. The predicate makes the transition the thing that is atomic, so a
   * second terminal write for the same execution matches nothing and is
   * refused instead of overwriting a settled outcome.
   *
   * `count !== 1` is a throw rather than a return value, and that is the half
   * that matters most. `updateMany` resolves normally when it matches nothing,
   * so a `succeed` whose row was absent, already terminal, or in another
   * tenant used to be indistinguishable from one that committed — and
   * `ToolGateway` would hand the model an output no durable row claimed. There
   * is no durable evidence to return in that case, so the call fails closed
   * and the gateway's containment turns it into a tool failure.
   *
   * `> 1` is unreachable — `id` is the primary key — and is still covered by
   * the same equality rather than by `count === 0`, because the assertion
   * being made is "exactly one row transitioned".
   *
   * Deliberately not a transaction and deliberately not a retry. One statement
   * with a discriminating predicate is already atomic in PostgreSQL, and a
   * losing transition is a fact to report, not a race to re-enter.
   */
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
      /**
       * Carries the execution id and the attempted status and nothing else.
       *
       * No tenant, no input, no output, no row contents: `ToolGateway` catches
       * this and replaces it with its own constant before anything reaches a
       * provider, but it is also the value a future caller might log, and the
       * id is enough to find the row that refused.
       */
      throw new ToolExecutionTransitionError(
        `ToolExecution "${id}" could not transition to ${status}`,
      );
    }
  }
}

/**
 * A terminal write that matched no `STARTED` row.
 *
 * Its own type so a caller can tell "the outcome was not recorded" from a
 * driver fault, without reading a message. Nothing does today — `ToolGateway`
 * contains every non-`ToolExecutionFailure` throw identically — but the
 * distinction is the one thing a reader of this failure needs, and recovering
 * it later from an `Error` would mean string matching.
 */
export class ToolExecutionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionTransitionError';
  }
}

function asJson(value: AgentValue): Prisma.InputJsonValue {
  return (value ?? Prisma.JsonNull) as Prisma.InputJsonValue;
}
