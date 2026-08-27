import { Module } from '@nestjs/common';

import { OrganizationAccessModule } from '../core/auth/organization-access.module';
import { DatabaseModule } from '../database';
import { OrganizationAuditModule } from '../organization-audit';
import { OrganizationBusinessProfileController } from './organization-business-profile.controller';
import { OrganizationBusinessProfileService } from './organization-business-profile.service';

@Module({
  imports: [DatabaseModule, OrganizationAccessModule, OrganizationAuditModule],
  controllers: [OrganizationBusinessProfileController],
  providers: [OrganizationBusinessProfileService],
  exports: [OrganizationBusinessProfileService],
})
export class OrganizationBusinessProfileModule {}
