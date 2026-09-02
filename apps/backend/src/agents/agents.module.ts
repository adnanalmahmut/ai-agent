import { Module } from '@nestjs/common';

import { OutboxPersistenceModule } from '../infrastructure/outbox';
import { DatabaseModule } from '../infrastructure/database';
import { AgentDefinitionsModule } from './agent-definitions.module';
import { AgentRunService } from './agent-run.service';

@Module({
  imports: [DatabaseModule, OutboxPersistenceModule, AgentDefinitionsModule],
  providers: [AgentRunService],
  exports: [AgentRunService],
})
export class AgentsModule {}
