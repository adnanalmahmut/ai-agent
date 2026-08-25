import { Injectable } from '@nestjs/common';

import { AgentConfigurationError } from './agent-configuration.error';
import { AgentContextAssembler } from './agent-context.assembler';
import { AgentDefinitionRegistry } from './agent-definition.registry';
import { AgentOutputContractError } from './agent-output-contract.error';
import { AgentRuntimeRegistry } from './agent-runtime.registry';
import type { AgentRun, AgentRuntimeResult, AgentValue } from './agent.types';

/** Resolves application definitions before crossing a runtime boundary. */
@Injectable()
export class AgentRunner {
  constructor(
    private readonly definitions: AgentDefinitionRegistry,
    private readonly runtimes: AgentRuntimeRegistry,
    private readonly context: AgentContextAssembler,
  ) {}

  async run(
    run: Pick<
      AgentRun,
      'agentId' | 'agentVersion' | 'runtime' | 'input' | 'organizationId'
    >,
  ): Promise<AgentRuntimeResult> {
    // The persisted pair, not just the id: this run must execute the revision
    // it was accepted against even if a newer one has since been deployed.
    const definition = this.definitions.resolve(run.agentId, run.agentVersion);

    if (definition.runtime !== run.runtime) {
      // Two durable facts that disagree. Neither one changes while the run is
      // in flight, so this cannot come right on a later attempt.
      throw new AgentConfigurationError(
        `AgentRun runtime "${run.runtime}" does not match definition runtime "${definition.runtime}"`,
      );
    }

    /**
     * Parsed here rather than trusted from the row.
     *
     * The input was validated when the run was accepted, but that was against
     * whatever the definition's schema said *then*. This run is pinned to a
     * definition version and may execute days later, so the schema it is
     * checked against is the one it will actually be run with. A stored input
     * that no longer satisfies it is a configuration problem, not a transient
     * one, and retrying cannot change the answer.
     */
    const parsedInput = definition.input.safeParse(run.input);

    if (!parsedInput.success) {
      throw new AgentConfigurationError(
        `AgentRun input does not satisfy definition "${definition.id}@${definition.version}"`,
      );
    }

    const context = await this.context.assemble({
      organizationId: run.organizationId,
      policy: definition.contextPolicy,
      query: queryOf(parsedInput.data as AgentValue),
    });

    const result = await this.runtimes.resolve(definition.runtime).run({
      definition,
      input: parsedInput.data as AgentValue,
      context,
    });

    /**
     * The provider's answer is parsed before it becomes the run's output.
     *
     * A model is an untrusted source that this application happens to pay
     * for. Storing whatever came back would make `AgentRun.output` a shape no
     * consumer could rely on, and every reader downstream would have to
     * re-check it — or, more likely, not.
     */
    const parsedOutput = definition.output.safeParse(result.output);

    if (!parsedOutput.success) {
      // Deliberately not an `AgentConfigurationError`: a model that returned
      // the wrong shape once may well return the right one on the next
      // attempt, so this keeps its retry budget.
      throw new Error('Agent output does not satisfy its declared schema');
    }

    /**
     * The second half of the output contract, and the half a schema cannot
     * state: what the answer must be true of *given the request*.
     *
     * `numberOfIdeas` is the motivating case. A request for five ideas that
     * comes back with four parses perfectly — the array is bounded and every
     * member is well-formed — and is still the wrong answer to the question the
     * caller was billed for. Checked here rather than in the handler because
     * this is the last point before the value is returned for durable storage,
     * and checked after the schema parse so a contract only ever sees data it
     * can rely on.
     *
     * Not an `AgentConfigurationError`, deliberately, for the same reason a
     * malformed answer is not one: the count is the model's to get right and its
     * next attempt may. Classifying it as deterministic would make a miscount
     * immediately final and spend nothing of the retry budget the failure is
     * actually eligible for.
     *
     * It carries its own class all the same, so the worker can *name* it in a
     * log without changing how it is retried. Without that, a model that has
     * started miscounting is indistinguishable from a provider outage or a
     * timeout — three problems with three different remedies, all reported as
     * `runtime_error`. The class is application-owned and so is everything in
     * it: a closed code and, for a count, two integers. Its message is composed
     * from those, so a contract cannot put the provider's answer into an `Error`
     * even by accident, because the type will not carry text.
     */
    const violation = definition.outputContract?.(
      parsedInput.data as AgentValue,
      parsedOutput.data as AgentValue,
    );

    if (violation !== undefined && violation !== null) {
      throw new AgentOutputContractError(violation);
    }

    return { output: parsedOutput.data as AgentValue };
  }
}

/**
 * What the retrieval is made similar to.
 *
 * A string input is its own query. A structured one is flattened to its string
 * leaves rather than to `JSON.stringify`, because the keys and punctuation of
 * the envelope are not part of what the caller is asking about and embedding
 * them moves the query away from the material.
 */
function queryOf(input: AgentValue): string {
  const parts: string[] = [];

  const walk = (value: AgentValue): void => {
    if (typeof value === 'string') {
      parts.push(value);

      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item);

      return;
    }

    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item);
    }
  };

  walk(input);

  return parts.join('\n').trim();
}
