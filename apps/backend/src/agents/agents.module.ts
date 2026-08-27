import { Module } from '@nestjs/common';

import { OutboxPersistenceModule } from '../core/outbox';
import { DatabaseModule } from '../database';
import { AgentDefinitionsModule } from './agent-definitions.module';
import { AgentRunService } from './agent-run.service';

@Module({
  imports: [DatabaseModule, OutboxPersistenceModule, AgentDefinitionsModule],
  providers: [AgentRunService],
  exports: [AgentRunService],
})
export class AgentsModule {}
