import { Injectable } from '@nestjs/common';

import { AgentContextAssembler } from '../agent-context.assembler';
import type { AgentValue } from '../../../ai/agents/agent.types';
import { knowledgeSearchInput } from './knowledge-search';
import type {
  ToolImplementation,
  ToolInvocationContext,
  ToolRef,
} from '../../../ai/tools/tool.types';

/**
 * `knowledge.search@1`, over the Knowledge path the application already owns.
 *
 * This is `AgentContextAssembler` again on purpose. The alternative — a second
 * retrieval path built for tools — would mean two places that decide which
 * spaces a tenant may read, and the tool one would be the newer, less-tested,
 * model-facing half. Reusing the assembler means this tool inherits every
 * property already proven: slugs resolved against the caller's own
 * organization, the definition's `contextPolicy` as the maximum visibility,
 * embedding through `EMBEDDING_PORT`, the operator-owned retrieval ceiling, and
 * whole ranked passages inside the chunk and character budgets.
 *
 * The difference between the two callers is only *when*: the assembler is
 * invoked once before generation with the run's input as the query, and this
 * tool is invoked during generation with a query the model chose. The model
 * chooses the question. It does not choose the corpus.
 */
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
      /**
       * The pinned definition's policy, not a parameter.
       *
       * An agent with no `contextPolicy` sees nothing here — the assembler
       * treats an absent or empty policy as no context rather than as every
       * space, so granting this tool to an agent that may read nothing grants
       * the ability to search nothing.
       */
      policy: context.definition.contextPolicy,
      query,
    });

    return { passages };
  }
}
