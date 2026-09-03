import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database';
import { OrganizationAccess } from './organization-access.service';
import { OrganizationPermissionGuard } from './organization-permission.guard';

/**
 * Organization authorization, for any feature module with tenant-scoped routes.
 *
 * Deliberately separate from `AppAuthModule`. That module builds the Better
 * Auth instance and mounts its handler; a feature that only needs to ask
 * "may this member do this here" should not have to import the whole
 * authentication stack to find out.
 */
@Module({
  imports: [DatabaseModule],
  providers: [OrganizationAccess, OrganizationPermissionGuard],
  exports: [OrganizationAccess, OrganizationPermissionGuard],
})
export class OrganizationAccessModule {}
