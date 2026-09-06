import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database';
import { OrganizationAccess } from './organization-access.service';
import { OrganizationPermissionGuard } from './organization-permission.guard';

@Module({
  imports: [DatabaseModule],
  providers: [OrganizationAccess, OrganizationPermissionGuard],
  exports: [OrganizationAccess, OrganizationPermissionGuard],
})
export class OrganizationAccessModule {}
