import { Inject, Injectable } from '@nestjs/common';

import { AgentConfigurationError } from '../agent-configuration.error';
import type {
  AgentDefinition,
  AgentRuntimeTool,
  AgentValue,
} from '../agent.types';
import { ToolExecutionService } from './tool-execution.service';
import { ToolRegistry } from './tool.registry';
import {
  isToolRef,
  toolRef,
  type ToolDefinition,
  type ToolImplementation,
  type ToolInvocationContext,
  type ToolRef,
} from './tool.types';

/**
 * Thrown when a tool implementation fails. Carries no cause.
 *
 * The gateway catches the implementation's error and rethrows this instead, so
 * whatever the implementation threw — a provider body, a driver error, a stack
 * — dies at the boundary rather than travelling up into the run's failure path
 * or a log line. The run still fails; it just fails with the application's own
 * sentence.
 */
export class ToolExecutionFailure extends Error {}

export const TOOL_IMPLEMENTATIONS = Symbol('TOOL_IMPLEMENTATIONS');

/**
 * The application's authority over everything an agent may do.
 *
 * The runtime never receives this object, the registry, Prisma, the Knowledge
 * services, or grant state. It receives an array of closures for exactly the
 * tools the run may call, each one already bound to the run it belongs to. So
 * the interesting property is not that the gateway checks the caller's
 * identity — it is that the caller has no way to *express* one. There is no
 * organization id, run id, version id, or scope in a tool's input, because the
 * only thing the model can supply is the tool's own arguments.
 *
 * The checks still run on every call. A model that names a tool it was not
 * given, an adapter that invents a name, or a future runtime that keeps a
 * closure past its run all fail closed, because the closure re-verifies rather
 * than trusting that it was only handed out correctly.
 */
@Injectable()
export class ToolGateway {
  private readonly implementations: ReadonlyMap<ToolRef, ToolImplementation>;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly executions: ToolExecutionService,
    @Inject(TOOL_IMPLEMENTATIONS)
    implementations: readonly ToolImplementation[],
  ) {
    const indexed = new Map<ToolRef, ToolImplementation>();

    for (const implementation of implementations) {
      const { ref } = implementation;

      if (!isToolRef(ref) || !this.registry.has(ref)) {
        throw new Error(
          `Tool implementation "${String(ref)}" is not registered`,
        );
      }
      if (indexed.has(ref)) {
        throw new Error(`Duplicate tool implementation "${ref}"`);
      }

      indexed.set(ref, implementation);
    }

    // A registered tool with no implementation is a grant an organization can
    // select and an agent can be handed, which then fails on some later run.
    // Composition is the right moment to discover that.
    for (const ref of this.registry.refs()) {
      if (!indexed.has(ref)) {
        throw new Error(`Tool "${ref}" has no registered implementation`);
      }
    }

    this.implementations = indexed;
  }

  /**
   * The exact tools one accepted run may call.
   *
   * Both pins are consulted and the narrower wins. The definition's maximum is
   * what the code-owned revision permits; the organization's selection is what
   * the tenant chose within it. An organization grant outside the maximum is a
   * refusal rather than an intersection — a stored grant that no longer fits
   * its definition means the two durable facts disagree, and quietly dropping
   * the extra one would hide that.
   *
   * Deterministic, so it must not consume a retry budget: an
   * `AgentConfigurationError` says the same thing on every attempt.
   */
  authorize(input: {
    definition: AgentDefinition;
    organizationId: string;
    agentRunId: string;
    agentRunAttempt: number;
    /** Verbatim from the run's pinned `OrganizationAgentVersion`. */
    grants: readonly string[];
  }): readonly AgentRuntimeTool[] {
    const maximum = new Set<ToolRef>(input.definition.maxToolGrants ?? []);
    const context: ToolInvocationContext = {
      organizationId: input.organizationId,
      agentRunId: input.agentRunId,
      agentRunAttempt: input.agentRunAttempt,
      definition: input.definition,
    };

    const selected = new Set<ToolRef>();

    for (const grant of input.grants) {
      // A stored string, so it is parsed rather than trusted. The column is
      // written by validated application code, but a row is a row: a value
      // that reached it another way must fail here, not resolve to something.
      if (!isToolRef(grant) || !this.registry.has(grant)) {
        throw new AgentConfigurationError(
          `AgentRun organization version grants unknown tool "${grant}"`,
        );
      }
      if (!maximum.has(grant)) {
        throw new AgentConfigurationError(
          `AgentRun organization version grants tool "${grant}" outside its definition maximum`,
        );
      }
      selected.add(grant);
    }

    return [...selected].map((ref) => this.expose(ref, context));
  }

  /** One authorized tool, as the smallest thing a runtime can be given. */
  private expose(
    ref: ToolRef,
    context: ToolInvocationContext,
  ): AgentRuntimeTool {
    const definition = this.registry.resolve(ref);

    /**
     * Refused here rather than at registration.
     *
     * A `side_effect` tool is a legitimate thing to *have* in the registry — a
     * later change adds the machinery that runs one safely — but nothing in
     * this build knows how to make an external effect idempotent, revalidate a
     * precondition, or ask a human. Until that exists, exposing one would be
     * offering a capability the application cannot honour.
     */
    if (definition.risk !== 'read_only') {
      throw new AgentConfigurationError(
        `Tool "${ref}" is not read-only and cannot be executed by this build`,
      );
    }

    return {
      // The audited SDK-safe name, not the durable identity. See
      // `ToolDefinition.runtimeName`.
      name: definition.runtimeName,
      description: definition.description,
      input: definition.input,
      output: definition.output,
      execute: (input: AgentValue) =>
        this.execute(ref, definition, context, input),
    };
  }

  /**
   * One call, from an untrusted caller, in order.
   *
   * Parse the input, record that it was permitted, run it, parse the result,
   * record the outcome. The order is the point: nothing durable is written for
   * a call that was refused, and nothing is returned that was not parsed.
   */
  private async execute(
    ref: ToolRef,
    definition: ToolDefinition,
    context: ToolInvocationContext,
    rawInput: AgentValue,
  ): Promise<AgentValue> {
    /**
     * Parsed again, even though Mastra validates tool arguments itself.
     *
     * The SDK's validation is the SDK's, and it sits on the far side of a
     * boundary this application does not own. If a future adapter, a different
     * runtime, or a provider streaming a partial tool call ever produced
     * arguments the SDK did not check, this is the parse that still refuses
     * them. An unparsed input never reaches an implementation and never
     * reaches the database.
     */
    const parsedInput = definition.input.safeParse(rawInput);

    if (!parsedInput.success) {
      // No `ToolExecution` row: this was never permitted to run, and a refused
      // call must not be indistinguishable from a failed one in history.
      throw new ToolExecutionFailure(`Tool "${ref}" received invalid input`);
    }

    const implementation = this.implementations.get(ref);

    if (!implementation) {
      throw new AgentConfigurationError(`Tool "${ref}" has no implementation`);
    }

    const input = parsedInput.data as AgentValue;

    const executionId = await this.executions.start({
      organizationId: context.organizationId,
      agentRunId: context.agentRunId,
      agentRunAttempt: context.agentRunAttempt,
      toolId: definition.id,
      toolVersion: definition.version,
      input,
    });

    let raw: unknown;

    try {
      raw = await implementation.execute(input, context);
    } catch {
      /**
       * The caught value is never read. Not its message, not its cause, not
       * its name — an implementation calls out to embeddings and the database,
       * and either can throw something carrying a query, a payload, or a
       * credential-bearing URL.
       */
      await this.executions.fail(executionId, 'implementation_error');

      throw new ToolExecutionFailure(`Tool "${ref}" failed`);
    }

    /**
     * The implementation's own answer is parsed before it is stored or
     * returned.
     *
     * It is application code, so this is a weaker trust boundary than the
     * input parse — but the value goes into a durable column and into a
     * prompt, and "the tool promised this shape" is worth being true rather
     * than assumed. An implementation whose output drifts from its declared
     * schema fails closed instead of teaching the model a shape no reader
     * expects.
     */
    const parsedOutput = definition.output.safeParse(raw);

    if (!parsedOutput.success) {
      await this.executions.fail(executionId, 'output_rejected');

      throw new ToolExecutionFailure(
        `Tool "${ref}" returned a result its schema refuses`,
      );
    }

    const output = parsedOutput.data as AgentValue;
    await this.executions.succeed(executionId, output);

    return output;
  }
}

export { toolRef };
