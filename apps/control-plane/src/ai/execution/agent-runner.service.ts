import { Inject, Injectable } from '@nestjs/common';

import { AgentConfigurationError } from '../agents/agent-configuration.error';
import { AgentDefinitionRegistry } from '../agents/agent-definition.registry';
import type {
  AgentConfiguration,
  AgentDefinition,
  AgentRun,
  AgentRuntimeResult,
  AgentValue,
} from '../agents/agent.types';
import { ToolGateway } from '../tools/tool.gateway';
import { AGENT_CONTEXT, type AgentContextPort } from './agent-context.port';
import { AgentOutputContractError } from './agent-output-contract.error';
import { AgentRuntimeRegistry } from './agent-runtime.registry';
import { AgentRunService } from './agent-run.service';
import { contextQueryOf, resolveModelId } from './step-pinning';

@Injectable()
export class AgentRunner {
  constructor(
    private readonly definitions: AgentDefinitionRegistry,
    private readonly runtimes: AgentRuntimeRegistry,
    @Inject(AGENT_CONTEXT) private readonly context: AgentContextPort,
    private readonly runs: AgentRunService,
    private readonly tools: ToolGateway,
  ) {}

  async run(
    run: Pick<
      AgentRun,
      | 'id'
      | 'agentId'
      | 'agentVersion'
      | 'runtime'
      | 'input'
      | 'organizationId'
      | 'organizationAgentVersionId'
      | 'modelPolicyId'
      | 'modelId'
      | 'modelPricingRevisionId'
      | 'attemptCount'
      | 'createdAt'
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

    const model = resolveModelId(definition, run);

    const { organizationAgentVersionId } = run;
    const pinned = await this.runs.pinnedVersionFor({
      ...run,
      organizationAgentVersionId,
    });
    const configuration = parseConfiguration(
      definition,
      pinned?.configuration ?? null,
      organizationAgentVersionId !== null,
    );

    const tools = this.tools.authorize({
      definition,
      organizationId: run.organizationId,
      agentRunId: run.id,
      agentRunAttempt: run.attemptCount,
      grants: pinned?.toolGrants ?? [],
    });

    const parsedInput = definition.input.safeParse(run.input);

    if (!parsedInput.success) {
      throw new AgentConfigurationError(
        `AgentRun input does not satisfy definition "${definition.id}@${definition.version}"`,
      );
    }

    const context = await this.context.assemble({
      organizationId: run.organizationId,
      policy: definition.contextPolicy,
      query: contextQueryOf(parsedInput.data as AgentValue),
    });

    const result = await this.runtimes.resolve(definition.runtime).run({
      definition,
      model,
      configuration,
      input: parsedInput.data as AgentValue,
      context,
      tools,
    });

    const parsedOutput = definition.output.safeParse(result.output);

    if (!parsedOutput.success) {
      // Deliberately not an `AgentConfigurationError`: a model that returned
      // the wrong shape once may well return the right one on the next
      // attempt, so this keeps its retry budget.
      throw new Error('Agent output does not satisfy its declared schema');
    }

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

function parseConfiguration(
  definition: AgentDefinition,
  stored: AgentConfiguration | null,
  pinned: boolean,
): AgentConfiguration {
  const contract = definition.organizationConfiguration;

  // A definition with no contract was never installable, so only an
  // unpinned compatibility run may reach one. A run pinned to an
  // organization version of it contradicts its own durable identity.
  if (!contract) {
    if (!pinned) return {};
    throw new AgentConfigurationError(
      `Pinned definition "${definition.id}@${definition.version}" is not installable`,
    );
  }

  try {
    return contract.schema.parse(stored ?? contract.defaultValue);
  } catch {
    throw new AgentConfigurationError(
      `AgentRun configuration does not satisfy definition "${definition.id}@${definition.version}"`,
    );
  }
}
