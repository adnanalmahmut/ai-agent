import { Module } from '@nestjs/common';

import {
  AGENT_DEFINITIONS,
  AgentDefinitionRegistry,
} from './agent-definition.registry';
import { AgentExecutionHandler } from './agent-execution.handler';
import { AgentRunner } from './agent-runner.service';
import { AgentRuntimeRegistry } from './agent-runtime.registry';
import { AgentsModule } from './agents.module';
import { PRODUCTION_AGENT_DEFINITIONS } from './definitions';
import { MastraRuntime } from './runtime/mastra/mastra.runtime';

/** Worker-only composition for durable background agent execution. */
@Module({
  imports: [AgentsModule],
  providers: [
    { provide: AGENT_DEFINITIONS, useValue: PRODUCTION_AGENT_DEFINITIONS },
    AgentDefinitionRegistry,
    MastraRuntime,
    AgentRuntimeRegistry,
    AgentRunner,
    AgentExecutionHandler,
  ],
  exports: [AgentExecutionHandler],
})
export class AgentExecutionModule {}
