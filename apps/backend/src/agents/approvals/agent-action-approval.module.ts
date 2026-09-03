import { Module } from '@nestjs/common';

import { OrganizationAccessModule } from '../../infrastructure/auth/organization-access.module';
import { OutboxPersistenceModule } from '../../infrastructure/outbox';
import { DatabaseModule } from '../../infrastructure/database';
import { OrganizationAuditModule } from '../../organization-audit';
import { AgentActionApprovalController } from './agent-action-approval.controller';
import { AgentActionApprovalService } from './agent-action-approval.service';

/**
 * The API half of human approval.
 *
 * `OutboxPersistenceModule`, not `OutboxModule`: this process writes the event
 * that will perform the effect and never publishes it. The worker's dispatcher
 * turns the row into a job, which is what keeps the request path free of a
 * queue connection — an approval commits even while Redis is down.
 */
@Module({
  imports: [
    DatabaseModule,
    OutboxPersistenceModule,
    OrganizationAuditModule,
    OrganizationAccessModule,
  ],
  controllers: [AgentActionApprovalController],
  providers: [AgentActionApprovalService],
  exports: [AgentActionApprovalService],
})
export class AgentActionApprovalModule {}
