import { Module } from '@nestjs/common';

import { OutboxPersistenceModule } from '../infrastructure/outbox';
import { DatabaseModule } from '../infrastructure/database';
import { AgentRunService } from '../ai/execution/agent-run.service';
import { AgentDefinitionsModule } from './agent-definitions.module';

@Module({
  imports: [DatabaseModule, OutboxPersistenceModule, AgentDefinitionsModule],
  providers: [AgentRunService],
  exports: [AgentRunService],
})
export class AgentsModule {}
