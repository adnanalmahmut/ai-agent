export { AppAuthModule } from './auth.module';
export { createAuthMailCallbacks } from './auth-mail';
export type { AppAuth } from './auth.factory';

export {
  DEFAULT_GLOBAL_ROLE,
  GLOBAL_ADMIN_ROLES,
  SUPER_ADMIN_ROLE,
  GLOBAL_PERMISSION_STATEMENTS,
  globalAccessControl,
  globalRoles,
  ORGANIZATION_CREATOR_ROLE,
  ORGANIZATION_PERMISSION_STATEMENTS,
  memberRoleHasPermission,
  organizationAccessControl,
  organizationRoles,
} from './permissions';
export type { GlobalRoleName, OrganizationRoleName } from './permissions';

export {
  ACCOUNT_DEACTIVATED_CODE,
  GUARDED_ORGANIZATION_PATHS,
  ORGANIZATION_ARCHIVED_CODE,
} from './auth-hooks';

export { AccountLifecycleService } from './account-lifecycle.service';
export { OrganizationLifecycleService } from './organization-lifecycle.service';

export { OrganizationAccess } from './organization-access.service';
export { OrganizationAccessModule } from './organization-access.module';
export {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from './organization-permission.guard';
