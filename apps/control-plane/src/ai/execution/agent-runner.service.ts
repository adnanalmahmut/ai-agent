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
import {
  APPLICATION_MODEL_CATALOG,
  type AgentModelId,
} from '../models/model-catalog';
import { ToolGateway } from '../tools/tool.gateway';
import { AGENT_CONTEXT, type AgentContextPort } from './agent-context.port';
import { AgentOutputContractError } from './agent-output-contract.error';
import { AgentRuntimeRegistry } from './agent-runtime.registry';
import { AgentRunService } from './agent-run.service';

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

    const model = pinnedModel(definition, run);

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
      query: queryOf(parsedInput.data as AgentValue),
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

function pinnedModel(
  definition: AgentDefinition,
  run: Pick<
    AgentRun,
    'modelPolicyId' | 'modelId' | 'modelPricingRevisionId' | 'createdAt'
  >,
): AgentModelId {
  const identities = [
    run.modelPolicyId,
    run.modelId,
    run.modelPricingRevisionId,
  ];
  if (identities.every((value) => value === null)) return definition.model;
  if (identities.some((value) => value === null)) {
    throw new AgentConfigurationError(
      'AgentRun model pin is only partially populated',
    );
  }
  if (
    run.modelPolicyId !== definition.modelPolicy.id ||
    !definition.modelPolicy.allowedModelIds.includes(run.modelId!)
  ) {
    throw new AgentConfigurationError(
      'AgentRun model does not satisfy its pinned definition policy',
    );
  }
  try {
    APPLICATION_MODEL_CATALOG.agentModel(run.modelId!);
    const pricing = APPLICATION_MODEL_CATALOG.pricingRevision(
      run.modelId!,
      run.createdAt,
    );
    if (pricing.id !== run.modelPricingRevisionId) {
      throw new Error('pricing mismatch');
    }
  } catch {
    throw new AgentConfigurationError(
      'AgentRun model or pricing revision is unavailable for execution',
    );
  }
  return run.modelId!;
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
