import { Injectable } from '@nestjs/common';

import type { AgentRuntime } from './agent-runtime';
import { MastraRuntime } from './runtime/mastra/mastra.runtime';

/** Deliberately explicit runtime mapping; adding a runtime is a code change. */
@Injectable()
export class AgentRuntimeRegistry {
  constructor(private readonly mastra: MastraRuntime) {}

  resolve(name: string): AgentRuntime {
    switch (name) {
      case 'mastra':
        return this.mastra;
      default:
        throw new Error(`Agent runtime "${name}" is not supported`);
    }
  }
}
