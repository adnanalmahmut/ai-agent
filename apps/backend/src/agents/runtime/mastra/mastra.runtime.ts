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

    const result = await agent.generate(toPrompt(request.input));
    return { output: result.text };
  }
}

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
