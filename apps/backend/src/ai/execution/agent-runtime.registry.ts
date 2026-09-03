import { Injectable } from '@nestjs/common';

import { AgentConfigurationError } from '../agents/agent-configuration.error';
import { MastraRuntime } from '../infrastructure/runtimes/mastra/mastra.runtime';
import type { AgentRuntime } from './agent-runtime';

/** Deliberately explicit runtime mapping; adding a runtime is a code change. */
@Injectable()
export class AgentRuntimeRegistry {
  constructor(private readonly mastra: MastraRuntime) {}

  resolve(name: string): AgentRuntime {
    switch (name) {
      case 'mastra':
        return this.mastra;
      default:
        // Deterministic for the same reason the definition registry's miss is:
        // the mapping is a `switch` in this file, not something a retry can
        // discover.
        throw new AgentConfigurationError(
          `Agent runtime "${name}" is not supported`,
        );
    }
  }
}
