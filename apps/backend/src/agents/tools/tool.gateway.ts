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
  type ToolDefinition,
  type ToolImplementation,
  type ToolInvocationContext,
  type ToolRef,
} from './tool.types';

/**
 * The only thing allowed to leave a tool call. Carries no cause and no stack.
 *
 * This is a containment type, not a control-flow one, because a thrown tool
 * error does not end the run. Mastra catches everything a tool throws except
 * its own `FGADeniedError` and turns it into a tool *result*, so an error
 * raised in here is not a failure signal travelling up to
 * `AgentExecutionHandler` — it is a value this application is about to send to
 * a provider.
 *
 * The installed `@mastra/core@1.61.0` handles it in two stages, and both are
 * why this class is shaped the way it is:
 *
 * 1. The tool-call step catches the throw and calls `serializeToolError`,
 *    which builds `{ name, message, stack, ...own enumerable properties }`.
 *    That object — stack included — is the failure representation that travels
 *    through the workflow result, the `tool-error` chunk, `onChunk`, and
 *    anything that persists a message list.
 * 2. Rendering that to the model goes through `createToolModelOutput`. For an
 *    application-executed tool the mode is `"text"`, so the provider receives
 *    `{ type: 'error-text', value: error.message }` — the message and nothing
 *    else. The sibling `"json"` mode, which emits `toJSONValue(error)`, is
 *    reached only by `providerExecuted` tools, which this build never
 *    registers.
 *
 * So a constant message would already bound stage 2 today. It would not bound
 * stage 1, and it would depend on the SDK continuing to pick `"text"` — a
 * choice made by a runtime literal this repository does not own. Rather than
 * assert that the replacement stack is harmless, the object is made to have
 * nothing to leak:
 *
 * - `message` is a constant naming only the tool. Anything a driver or an
 *   implementation threw — a query, a payload, a connection string — would
 *   otherwise be transmitted verbatim, and Pino's redaction is nowhere near
 *   this path.
 * - `name` is pinned to a bounded application constant. Left alone it would
 *   inherit `'Error'`, which is harmless but is also the field `"json"` mode
 *   actually emits.
 * - `stack` is discarded, so stage 1 has no file paths, no `node_modules`
 *   frames, and no repository layout to copy, and stage 2 cannot start
 *   reporting one if a future SDK switches modes.
 *
 * No own enumerable property is ever set on an instance, so the spread in
 * `serializeToolError` contributes nothing.
 *
 * Losing the stack costs no diagnosis. This value is caught by the SDK one
 * frame above where it is thrown and never reaches application error handling,
 * and the durable `ToolExecution` row — not the run's outcome, and not this
 * object — is the authority on what happened. A run whose tool failed can
 * still succeed, and its history will say a tool call failed inside it.
 */
export class ToolExecutionFailure extends Error {
  constructor(message: string) {
    super(message);

    /**
     * Set rather than left to the prototype: `class X extends Error` does not
     * set `name`, so an instance reports `'Error'`.
     *
     * `defineProperty` rather than assignment, because assignment would create
     * an own *enumerable* `name` and the whole point of this constructor is
     * that the instance has no own enumerable property at all. `Error.prototype`
     * declares `name` non-enumerable and this matches it, which also keeps
     * `JSON.stringify` of the value at `{}`.
     */
    Object.defineProperty(this, 'name', {
      value: 'ToolExecutionFailure',
      enumerable: false,
      writable: true,
      configurable: true,
    });

    /**
     * Removes the frames `Error` captured in `super()`.
     *
     * `delete` rather than assigning `undefined`, so the own property V8
     * installs is gone rather than present and empty. `serializeToolError`
     * reads `error.stack` and would see `undefined` either way; the difference
     * is that anything enumerating or copying own properties — a structured
     * clone, a spread, a serializer that walks `Object.getOwnPropertyNames` —
     * finds no `stack` to carry at all.
     */
    delete this.stack;
  }
}

export const TOOL_IMPLEMENTATIONS = Symbol('TOOL_IMPLEMENTATIONS');

/**
 * How many tool calls one run attempt may make in total.
 *
 * Separate from the runtime's step ceiling, and not implied by it: a step
 * bounds model round-trips, but one assistant step may emit many tool calls and
 * the SDK executes them all, bounding only their concurrency. So `maxSteps: 4`
 * permits four *rounds* of unbounded fan-out, and each `knowledge.search@1`
 * call costs an embedding this platform pays for, a vector search, and two
 * writes.
 *
 * The input schema stops the model choosing how much one call retrieves. This
 * stops it choosing how many calls there are — the same decision, reached by
 * repetition instead of by a parameter.
 *
 * Twelve: generous for an agent that searches, reads, refines and answers,
 * while bounding the worst case to something an operator would not notice on a
 * bill. Code-owned for this first real use case.
 */
const MAX_TOOL_INVOCATIONS_PER_ATTEMPT = 12;

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

      /**
       * Refused at composition, not merely when a run tries to use it.
       *
       * The check also exists in `expose`, but that one fires per run: a
       * definition that named a `side_effect` tool and an organization that
       * selected it would both be accepted, and then *every* run of that agent
       * would fail at authorize time — including runs where the model would
       * never have called it. Failing the build instead makes it one loud
       * error at the moment the tool is added.
       *
       * The change that adds idempotency, precondition revalidation and human
       * approval is the change that relaxes this line.
       */
      if (this.registry.resolve(ref).risk !== 'read_only') {
        throw new Error(
          `Tool "${ref}" is not read-only and this build cannot execute one`,
        );
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

    /**
     * One budget for the whole attempt, shared by every tool it exposes.
     *
     * Captured here rather than per tool, because the cost being bounded is
     * the run's, not any one tool's.
     */
    const budget = { remaining: MAX_TOOL_INVOCATIONS_PER_ATTEMPT };

    return [...selected].map((ref) =>
      this.expose(ref, context, selected, budget),
    );
  }

  /** One authorized tool, as the smallest thing a runtime can be given. */
  private expose(
    ref: ToolRef,
    context: ToolInvocationContext,
    authorized: ReadonlySet<ToolRef>,
    budget: { remaining: number },
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
        this.execute(ref, definition, context, authorized, budget, input),
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
      // Already contained, and already says only what it should.
      if (error instanceof ToolExecutionFailure) throw error;

      /**
       * Everything else: a durable write that rejected, or a defect in here.
       *
       * A Prisma rejection is the motivating case. Its message names the
       * connection target and, for an argument fault, renders the invocation
       * arguments — which at this point are the tool's input or output. Left
       * uncontained it would be serialized into the transcript and sent to the
       * provider on the next step, so nothing may pass but this sentence.
       */
      throw new ToolExecutionFailure(`Tool "${ref}" could not be completed`);
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
    /**
     * Re-checked here, not only where the closure was handed out.
     *
     * Nothing today can call a closure it was not given, so this cannot fire —
     * which is exactly why it is cheap and why it belongs here. A future
     * adapter that cached an `AgentRuntimeTool` across runs, or a change that
     * revoked a grant mid-attempt, would otherwise find no second gate.
     */
    if (!authorized.has(ref)) {
      throw new ToolExecutionFailure(`Tool "${ref}" is not authorized`);
    }

    if (budget.remaining <= 0) {
      throw new ToolExecutionFailure(
        `Tool "${ref}" exceeded this attempt's tool-call budget`,
      );
    }
    budget.remaining -= 1;
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
      await this.executions.fail(
        executionId,
        context.organizationId,
        'implementation_error',
      );

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
      await this.executions.fail(
        executionId,
        context.organizationId,
        'output_rejected',
      );

      throw new ToolExecutionFailure(
        `Tool "${ref}" returned a result its schema refuses`,
      );
    }

    const output = parsedOutput.data as AgentValue;
    await this.executions.succeed(executionId, context.organizationId, output);

    return output;
  }
}
