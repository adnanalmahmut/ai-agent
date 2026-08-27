import { Module } from '@nestjs/common';

import {
  AGENT_DEFINITIONS,
  AgentDefinitionRegistry,
} from './agent-definition.registry';
import { PRODUCTION_AGENT_DEFINITIONS } from './definitions';

/** Code-owned definitions shared by API orchestration and worker execution. */
@Module({
  providers: [
    { provide: AGENT_DEFINITIONS, useValue: PRODUCTION_AGENT_DEFINITIONS },
    AgentDefinitionRegistry,
  ],
  exports: [AgentDefinitionRegistry],
})
export class AgentDefinitionsModule {}
