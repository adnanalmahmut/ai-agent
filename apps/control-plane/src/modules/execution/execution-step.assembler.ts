import { Inject, Injectable } from '@nestjs/common';
import {
  EXECUTION_CONTRACT_VERSION,
  validateRuntimeStep,
  type RuntimeStep,
} from '@repo/execution-contracts';

import { AgentConfigurationError } from '../../ai/agents/agent-configuration.error';
import { AgentDefinitionRegistry } from '../../ai/agents/agent-definition.registry';
import type { AgentRun, AgentValue } from '../../ai/agents/agent.types';
import {
  AGENT_CONTEXT,
  type AgentContextPort,
} from '../../ai/execution/agent-context.port';
import { AgentRunService } from '../../ai/execution/agent-run.service';
import {
  contextQueryOf,
  resolveModelPin,
} from '../../ai/execution/step-pinning';
import { selectAuthorizedToolRefs } from '../../ai/tools/tool-grants';
import { ToolRegistry } from '../../ai/tools/tool.registry';

/**
 * The identity of one execution step, derived rather than issued.
 *
 * A run and the attempt ordinal that claimed it already name the work
 * uniquely, so there is no new identifier to mint, hand out and then have to
 * keep authoritative somewhere.
 */
export function stepIdFor(runId: string, attempt: number): string {
  return `${runId}:${attempt}`;
}

/**
 * Turning a claimed run into the document a worker in another process — and
 * another language — can execute.
 *
 * Everything here is read from durable state and serialised as JSON. No
 * Prisma row, `Date`, closure, provider client, credential or organization
 * record crosses this line: what comes out is reconstructable from its own
 * bytes, which is the property that makes moving the runtime out of process
 * a deployment change rather than a trust change.
 */
@Injectable()
export class ExecutionStepAssembler {
  constructor(
    private readonly definitions: AgentDefinitionRegistry,
    private readonly runs: AgentRunService,
    private readonly tools: ToolRegistry,
    @Inject(AGENT_CONTEXT) private readonly context: AgentContextPort,
  ) {}

  async assemble(run: AgentRun): Promise<RuntimeStep> {
    // The persisted pair, not just the id: this step must describe the
    // revision the run was accepted against, whatever has been deployed since.
    const definition = this.definitions.resolve(run.agentId, run.agentVersion);

    if (definition.runtime !== run.runtime) {
      throw new AgentConfigurationError(
        `AgentRun runtime "${run.runtime}" does not match definition runtime "${definition.runtime}"`,
      );
    }

    const model = resolveModelPin(definition, run);
    const pinned = await this.runs.pinnedVersionFor(run);
    const grantedTools = selectAuthorizedToolRefs(
      this.tools,
      definition,
      pinned?.toolGrants ?? [],
    );

    const parsedInput = definition.input.safeParse(run.input);

    if (!parsedInput.success) {
      throw new AgentConfigurationError(
        `AgentRun input does not satisfy definition "${definition.id}@${definition.version}"`,
      );
    }

    const input = parsedInput.data as AgentValue;
    const passages = await this.context.assemble({
      organizationId: run.organizationId,
      policy: definition.contextPolicy,
      query: contextQueryOf(input),
    });

    const step = {
      version: EXECUTION_CONTRACT_VERSION,
      stepId: stepIdFor(run.id, run.attemptCount),
      runId: run.id,
      organizationId: run.organizationId,
      attempt: run.attemptCount,
      acceptedAt: run.createdAt.toISOString(),
      agent: { id: definition.id, version: definition.version },
      model: {
        policyId: model.policyId,
        modelId: model.modelId,
        pricingRevisionId: model.pricingRevisionId,
      },
      input,
      context: passages.map((passage) => ({
        documentId: passage.documentId,
        chunkId: passage.chunkId,
        text: passage.content,
      })),
      grantedTools: [...grantedTools],
    };

    // The Control Plane validates its own output against the published
    // contract. A document that would not survive the boundary is a defect
    // here, not something to discover in another process.
    const checked = validateRuntimeStep(step);

    if (!checked.ok) {
      throw new AgentConfigurationError(
        `AgentRun does not serialise to a valid execution step: ${describe(checked.issues)}`,
      );
    }

    return checked.value;
  }
}

function describe(
  issues: readonly { path: string; message: string }[],
): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path} ${issue.message}`)
    .join('; ');
}
