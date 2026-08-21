import { Module } from '@nestjs/common';

import { OutboxPersistenceModule } from '../core/outbox';
import { DatabaseModule } from '../database';
import { AgentRunService } from './agent-run.service';

@Module({
  imports: [DatabaseModule, OutboxPersistenceModule],
  providers: [AgentRunService],
  exports: [AgentRunService],
})
export class AgentsModule {}
