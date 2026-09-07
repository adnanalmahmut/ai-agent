import { Inject, Injectable } from '@nestjs/common';

import { AgentConfigurationError } from '../agents/agent-configuration.error';
import type {
  AgentDefinition,
  AgentRuntimeTool,
  AgentValue,
} from '../agents/agent.types';
import { ToolExecutionService } from './tool-execution.service';
import { selectAuthorizedToolRefs } from './tool-grants';
import { ToolRegistry } from './tool.registry';
import {
  isSideEffectImplementation,
  isSideEffectPreconditionError,
  isToolRef,
  type AnyToolImplementation,
  type ToolDefinition,
  type ToolInvocationContext,
  type ToolRef,
} from './tool.types';

export class ToolExecutionFailure extends Error {
  constructor(message: string) {
    super(message);

    Object.defineProperty(this, 'name', {
      value: 'ToolExecutionFailure',
      enumerable: false,
      writable: true,
      configurable: true,
    });

    // This error crosses the SDK/tool-result boundary. Remove the stack so
    // provider-visible serialization cannot expose repository paths.
    delete this.stack;
  }
}

export const TOOL_IMPLEMENTATIONS = Symbol('TOOL_IMPLEMENTATIONS');

const MAX_TOOL_INVOCATIONS_PER_ATTEMPT = 12;

@Injectable()
export class ToolGateway {
  private readonly implementations: ReadonlyMap<ToolRef, AnyToolImplementation>;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly executions: ToolExecutionService,
    @Inject(TOOL_IMPLEMENTATIONS)
    implementations: readonly AnyToolImplementation[],
  ) {
    const indexed = new Map<ToolRef, AnyToolImplementation>();

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

    // Refuse grantable tools that cannot execute before serving traffic.
    for (const ref of this.registry.refs()) {
      if (!indexed.has(ref)) {
        throw new Error(`Tool "${ref}" has no registered implementation`);
      }

      const definition = this.registry.resolve(ref);
      const implementation = indexed.get(ref) as AnyToolImplementation;
      const sideEffect = isSideEffectImplementation(implementation);

      if ((definition.risk === 'side_effect') !== sideEffect) {
        throw new Error(
          `Tool "${ref}" is classified ${definition.risk} but its implementation is not`,
        );
      }
    }

    this.implementations = indexed;
  }

  authorize(input: {
    definition: AgentDefinition;
    organizationId: string;
    agentRunId: string;
    agentRunAttempt: number;
    grants: readonly string[];
  }): readonly AgentRuntimeTool[] {
    const context: ToolInvocationContext = {
      organizationId: input.organizationId,
      agentRunId: input.agentRunId,
      agentRunAttempt: input.agentRunAttempt,
      definition: input.definition,
    };

    const refs = selectAuthorizedToolRefs(
      this.registry,
      input.definition,
      input.grants,
    );
    const selected = new Set<ToolRef>(refs);
    const budget = { remaining: MAX_TOOL_INVOCATIONS_PER_ATTEMPT };

    return refs.map((ref) => this.expose(ref, context, selected, budget));
  }

  private expose(
    ref: ToolRef,
    context: ToolInvocationContext,
    authorized: ReadonlySet<ToolRef>,
    budget: { remaining: number },
  ): AgentRuntimeTool {
    const definition = this.registry.resolve(ref);

    return {
      name: definition.runtimeName,
      description: definition.description,
      input: definition.input,
      output: definition.output,
      execute: (input: AgentValue) =>
        this.execute(ref, definition, context, authorized, budget, input),
    };
  }

  private async execute(
    ref: ToolRef,
    definition: ToolDefinition,
    context: ToolInvocationContext,
    authorized: ReadonlySet<ToolRef>,
    budget: { remaining: number },
    rawInput: AgentValue,
  ): Promise<AgentValue> {
    try {
      return await this.attempt(
        ref,
        definition,
        context,
        authorized,
        budget,
        rawInput,
      );
    } catch (error) {
      if (error instanceof ToolExecutionFailure) throw error;

      throw new ToolExecutionFailure(
        `Tool "${definition.runtimeName}" could not be completed`,
      );
    }
  }

  private async attempt(
    ref: ToolRef,
    definition: ToolDefinition,
    context: ToolInvocationContext,
    authorized: ReadonlySet<ToolRef>,
    budget: { remaining: number },
    rawInput: AgentValue,
  ): Promise<AgentValue> {
    if (!authorized.has(ref)) {
      throw new ToolExecutionFailure(
        `Tool "${definition.runtimeName}" is not authorized`,
      );
    }

    if (budget.remaining <= 0) {
      throw new ToolExecutionFailure(
        `Tool "${definition.runtimeName}" exceeded this attempt's tool-call budget`,
      );
    }
    budget.remaining -= 1;
    const parsedInput = definition.input.safeParse(rawInput);

    if (!parsedInput.success) {
      // Refused calls never enter execution history.
      throw new ToolExecutionFailure(
        `Tool "${definition.runtimeName}" received invalid input`,
      );
    }

    const implementation = this.implementations.get(ref);

    if (!implementation) {
      throw new AgentConfigurationError(`Tool "${ref}" has no implementation`);
    }

    const input = parsedInput.data as AgentValue;

    if (isSideEffectImplementation(implementation)) {
      return this.propose(definition, implementation, context, input);
    }

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
      await this.executions.fail(
        executionId,
        context.organizationId,
        'implementation_error',
      );

      throw new ToolExecutionFailure(`Tool "${definition.runtimeName}" failed`);
    }

    const parsedOutput = definition.output.safeParse(raw);

    if (!parsedOutput.success) {
      await this.executions.fail(
        executionId,
        context.organizationId,
        'output_rejected',
      );

      throw new ToolExecutionFailure(
        `Tool "${definition.runtimeName}" returned a result its schema refuses`,
      );
    }

    const output = parsedOutput.data as AgentValue;
    await this.executions.succeed(executionId, context.organizationId, output);

    return output;
  }

  private async propose(
    definition: ToolDefinition,
    implementation: Extract<AnyToolImplementation, { kind: 'side_effect' }>,
    context: ToolInvocationContext,
    input: AgentValue,
  ): Promise<AgentValue> {
    try {
      await implementation.propose(input, context);
    } catch (error) {
      if (isSideEffectPreconditionError(error)) {
        throw new ToolExecutionFailure(
          `Tool "${definition.runtimeName}" could not record the proposal`,
        );
      }
      // Unknown failures are contained before crossing the runtime boundary.
      throw new ToolExecutionFailure(
        `Tool "${definition.runtimeName}" could not be completed`,
      );
    }

    await this.executions.propose({
      organizationId: context.organizationId,
      agentRunId: context.agentRunId,
      agentRunAttempt: context.agentRunAttempt,
      toolId: definition.id,
      toolVersion: definition.version,
      input,
    });

    const parsedOutput = definition.output.safeParse({
      status: 'awaiting_approval',
    });

    if (!parsedOutput.success) {
      // Fail closed if the schema cannot represent its approval state.
      throw new ToolExecutionFailure(
        `Tool "${definition.runtimeName}" returned a result its schema refuses`,
      );
    }

    return parsedOutput.data as AgentValue;
  }
}
