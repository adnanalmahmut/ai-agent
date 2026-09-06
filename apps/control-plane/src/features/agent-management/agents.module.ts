import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infrastructure/database';
import { AgentRunService } from '../../ai/execution/agent-run.service';

@Module({
  imports: [DatabaseModule],
  providers: [AgentRunService],
  exports: [AgentRunService],
})
export class AgentsModule {}
