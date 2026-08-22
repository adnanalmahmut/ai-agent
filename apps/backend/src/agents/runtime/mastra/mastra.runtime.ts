import { Injectable } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';
import { noopLogger } from '@mastra/core/logger';

import type { AgentRuntime } from '../../agent-runtime';
import { AGENT_RUNTIME_NAMES, type AgentValue } from '../../agent.types';

@Injectable()
export class MastraRuntime implements AgentRuntime {
  readonly name = AGENT_RUNTIME_NAMES.mastra;

  async run(request: Parameters<AgentRuntime['run']>[0]) {
    const { definition } = request;
    const agent = new Agent({
      id: definition.id,
      name: definition.id,
      instructions: definition.instructions,
      model: definition.model,
    });

    /**
     * Silences the SDK's own logger before anything can reach it.
     *
     * `MastraBase`'s constructor installs a `ConsoleLogger` at level `error`,
     * and the agent loop logs the raw provider error on failure. That error
     * carries the outbound request body — the instructions and the prompt built
     * from `AgentRun.input` — along with the provider response body, endpoint
     * URL and model id. It is written with `console.error`, so Pino's redaction
     * never sees it and it lands unredacted in worker container logs. No
     * environment variable turns it off: unlike the `Mastra` class, `MastraBase`
     * reads none.
     *
     * `noopLogger` is the SDK's own export, and the very object Mastra installs
     * for its documented `logger: false` configuration — so this is the
     * framework's discard logger rather than a hand-rolled stand-in that could
     * drift out of shape as `IMastraLogger` gains members. Assigning it to a
     * typed local instead of casting at the call site keeps that check.
     *
     * The documented alternative is `new Agent({ mastra: new Mastra({ logger:
     * false }) })`, which reaches this same method internally but also
     * constructs an in-memory store, an orchestration worker, a background-task
     * manager and a notification workflow. Paying for all of that to avoid one
     * typed method is the wrong trade for an adapter that deliberately uses no
     * Mastra infrastructure.
     *
     * Containment, not observability: these payloads are exactly the
     * provider-derived data that must not be logged, so they are dropped rather
     * than forwarded. The handler's constant diagnostic stays the only
     * description a failed run produces.
     */
    agent.__setLogger(containedLogger);

    const result = await agent.generate(toPrompt(request.input));
    return { output: result.text };
  }
}

/**
 * Typed as the SDK's parameter type on purpose. If a future `@mastra/core`
 * removes `__setLogger` or changes `IMastraLogger`, this fails `pnpm typecheck`
 * loudly instead of regressing into unredacted provider logging at runtime.
 */
const containedLogger: Parameters<Agent['__setLogger']>[0] = noopLogger;

function toPrompt(input: AgentValue): string {
  return typeof input === 'string' ? input : JSON.stringify(sortValue(input));
}

/** Sort object keys recursively so equivalent application JSON is stable. */
function sortValue(value: AgentValue): AgentValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
}
