import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents';
import { OrganizationAccessModule } from '../core/auth';
import { DatabaseModule } from '../database';
import { ContentProjectController } from './content-project.controller';
import { ContentProjectService } from './content-project.service';

/**
 * The content-project feature, in the API composition root only.
 *
 * The worker has no reason to construct this: nothing here is queued, and the
 * one write it performs happens inside the request that asked for it.
 */
@Module({
  imports: [AgentsModule, DatabaseModule, OrganizationAccessModule],
  controllers: [ContentProjectController],
  providers: [ContentProjectService],
  exports: [ContentProjectService],
})
export class ContentProjectModule {}
