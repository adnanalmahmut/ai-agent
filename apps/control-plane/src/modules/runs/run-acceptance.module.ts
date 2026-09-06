import { Module } from '@nestjs/common';

import { AgentDefinitionsModule } from '../../features/agent-management/agent-definitions.module';
import { DatabaseModule } from '../../infrastructure/database';
import { OutboxPersistenceModule } from '../../infrastructure/outbox';
import { AcceptAgentRunUseCase } from './accept-agent-run.use-case';

/**
 * Accepting a run needs a database, an outbox and the agent catalogue, and
 * nothing that knows how the work will later be delivered. Any composition
 * root that can take a request can import this.
 */
@Module({
  imports: [DatabaseModule, OutboxPersistenceModule, AgentDefinitionsModule],
  providers: [AcceptAgentRunUseCase],
  exports: [AcceptAgentRunUseCase],
})
export class RunAcceptanceModule {}
