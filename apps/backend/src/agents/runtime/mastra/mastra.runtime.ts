import { Injectable } from '@nestjs/common';
import { Agent } from '@mastra/core/agent';

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

    agent.__setLogger(containedLogger);

    const result = await agent.generate(toPrompt(request.input));
    return { output: result.text };
  }
}

/**
 * Mastra's base class installs a `ConsoleLogger` by default, and its execution
 * loop logs the raw provider error on failure. That error carries the outbound
 * request body — the instructions and the prompt built from `AgentRun.input` —
 * along with the provider response body, endpoint URL, and model id. Because
 * it is written with `console.error` rather than through the application
 * logger, Pino's redaction never sees it and it lands unredacted in worker
 * container logs.
 *
 * This is containment, not observability: the SDK's structured payloads are
 * exactly the provider-derived data that must not be logged, so they are
 * dropped at the boundary rather than forwarded. The handler's constant
 * diagnostic remains the only description a failed run produces.
 */
const containedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trackException: () => {},
  getTransports: () => new Map(),
  listLogs: () =>
    Promise.resolve({
      logs: [],
      total: 0,
      page: 0,
      perPage: 0,
      hasMore: false,
    }),
  listLogsByRunId: () =>
    Promise.resolve({
      logs: [],
      total: 0,
      page: 0,
      perPage: 0,
      hasMore: false,
    }),
} as unknown as Parameters<Agent['__setLogger']>[0];

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
