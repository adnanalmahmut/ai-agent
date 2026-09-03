import { Module } from '@nestjs/common';

import { OrganizationAccessModule } from '../../../infrastructure/auth/organization-access.module';
import { DatabaseModule } from '../../../infrastructure/database';
import { OrganizationAuditController } from './organization-audit.controller';
import { OrganizationAuditService } from './organization-audit.service';

@Module({
  imports: [DatabaseModule, OrganizationAccessModule],
  controllers: [OrganizationAuditController],
  providers: [OrganizationAuditService],
  exports: [OrganizationAuditService],
})
export class OrganizationAuditModule {}
