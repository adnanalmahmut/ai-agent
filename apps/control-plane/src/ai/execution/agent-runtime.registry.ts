import { Inject, Injectable } from '@nestjs/common';

import { AgentConfigurationError } from '../agents/agent-configuration.error';
import type { AgentRuntime } from './agent-runtime';

/**
 * The runtimes a composition root has decided to make available. Naming a
 * concrete one here would put an SDK in the import graph of every caller that
 * only ever needs the port.
 */
export const AGENT_RUNTIMES = Symbol('AGENT_RUNTIMES');

@Injectable()
export class AgentRuntimeRegistry {
  private readonly byName: ReadonlyMap<string, AgentRuntime>;

  constructor(@Inject(AGENT_RUNTIMES) runtimes: readonly AgentRuntime[]) {
    this.byName = new Map(runtimes.map((runtime) => [runtime.name, runtime]));
  }

  resolve(name: string): AgentRuntime {
    const runtime = this.byName.get(name);

    if (!runtime) {
      // Deterministic for the same reason the definition registry's miss is:
      // the mapping is fixed at composition, not something a retry can
      // discover.
      throw new AgentConfigurationError(
        `Agent runtime "${name}" is not supported`,
      );
    }

    return runtime;
  }
}
