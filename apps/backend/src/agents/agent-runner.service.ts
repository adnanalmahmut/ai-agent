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
    run: Pick<AgentRun, 'agentId' | 'runtime' | 'input'>,
  ): Promise<AgentRuntimeResult> {
    const definition = this.definitions.resolve(run.agentId);

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
