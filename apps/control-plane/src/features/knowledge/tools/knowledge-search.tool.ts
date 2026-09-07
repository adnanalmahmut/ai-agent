import { Injectable } from '@nestjs/common';

import { AgentContextAssembler } from '../agent-context.assembler';
import type { AgentValue } from '../../../ai/agents/agent.types';
import { knowledgeSearchInput } from './knowledge-search';
import type {
  ToolImplementation,
  ToolInvocationContext,
  ToolRef,
} from '../../../ai/tools/tool.types';

@Injectable()
export class KnowledgeSearchTool implements ToolImplementation {
  readonly ref: ToolRef = 'knowledge.search@1';

  constructor(private readonly context: AgentContextAssembler) {}

  async execute(
    input: AgentValue,
    context: ToolInvocationContext,
  ): Promise<unknown> {
    // Parsed again rather than trusted from the gateway. The gateway does parse
    // it, and this is one line: an implementation that assumed its input had
    // been checked would be the thing to change if a second caller ever existed.
    const { query } = knowledgeSearchInput.parse(input);

    const passages = await this.context.assemble({
      organizationId: context.organizationId,
      policy: context.definition.contextPolicy,
      query,
    });

    // Projected to exactly what this tool's own output contract declares. The
    // assembler carries chunk provenance for the execution document, and a
    // tool result that widened itself whenever an internal type grew would be
    // a contract nobody agreed to change.
    return {
      passages: passages.map(({ space, content }) => ({ space, content })),
    };
  }
}
