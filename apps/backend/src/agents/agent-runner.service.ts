import { Injectable } from '@nestjs/common';

import { AgentDefinitionRegistry } from './agent-definition.registry';
import { AgentRuntimeRegistry } from './agent-runtime.registry';
import type { AgentRun, AgentRuntimeResult } from './agent.types';

/** Resolves application definitions before crossing a runtime boundary. */
@Injectable()
export class AgentRunner {
  constructor(
    private readonly definitions: AgentDefinitionRegistry,
    private readonly runtimes: AgentRuntimeRegistry,
  ) {}

  async run(
    run: Pick<AgentRun, 'agentId' | 'agentVersion' | 'runtime' | 'input'>,
  ): Promise<AgentRuntimeResult> {
    // The persisted pair, not just the id: this run must execute the revision
    // it was accepted against even if a newer one has since been deployed.
    const definition = this.definitions.resolve(run.agentId, run.agentVersion);

    if (definition.runtime !== run.runtime) {
      throw new Error(
        `AgentRun runtime "${run.runtime}" does not match definition runtime "${definition.runtime}"`,
      );
    }

    return this.runtimes.resolve(definition.runtime).run({
      definition,
      input: run.input,
    });
  }
}
