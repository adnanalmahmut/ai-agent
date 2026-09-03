import { Module } from '@nestjs/common';

import { AgentsModule } from '../../agent-management';
import { OrganizationAccessModule } from '../../../infrastructure/auth';
import { DatabaseModule } from '../../../infrastructure/database';
import { OrganizationAuditModule } from '../../organizations/audit';
import { ContentProjectController } from './content-project.controller';
import { ContentProjectService } from './content-project.service';

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
