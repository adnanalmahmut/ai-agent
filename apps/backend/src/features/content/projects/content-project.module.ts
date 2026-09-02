import { Module } from '@nestjs/common';

import { AgentsModule } from '../../agent-management';
import { OrganizationAccessModule } from '../../../infrastructure/auth';
import { DatabaseModule } from '../../../infrastructure/database';
import { OrganizationAuditModule } from '../../organizations/audit';
import { ContentProjectController } from './content-project.controller';
import { ContentProjectService } from './content-project.service';

/**
 * The content-project feature, in the API composition root only.
 *
 * The worker has no reason to construct this: nothing here is queued, and the
 * one write it performs happens inside the request that asked for it.
 */
@Module({
  imports: [
    AgentsModule,
    DatabaseModule,
    OrganizationAccessModule,
    OrganizationAuditModule,
  ],
  controllers: [ContentProjectController],
  providers: [ContentProjectService],
  exports: [ContentProjectService],
})
export class ContentProjectModule {}
