import { Module } from '@nestjs/common';

import { OrganizationAccessModule } from '../../../infrastructure/auth/organization-access.module';
import { OutboxPersistenceModule } from '../../../infrastructure/outbox';
import { DatabaseModule } from '../../../infrastructure/database';
import { OrganizationAuditModule } from '../../organizations/audit';
import { AgentActionApprovalController } from './agent-action-approval.controller';
import { AgentActionApprovalService } from './agent-action-approval.service';

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
