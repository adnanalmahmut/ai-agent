import { Module } from '@nestjs/common';

import {
  AGENT_DEFINITIONS,
  AgentDefinitionRegistry,
} from '../../ai/agents/agent-definition.registry';
import { PRODUCTION_AGENT_DEFINITIONS } from '../content/ideas/agent-definitions';

@Module({
  providers: [
    { provide: AGENT_DEFINITIONS, useValue: PRODUCTION_AGENT_DEFINITIONS },
    AgentDefinitionRegistry,
  ],
  exports: [AgentDefinitionRegistry],
})
export class AgentDefinitionsModule {}
