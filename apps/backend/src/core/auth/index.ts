/**
 * Public surface of the auth module.
 *
 * The Better Auth instance itself is not exported: it is constructed inside
 * the dynamic module and reached through the library's `AuthService`, so
 * nothing here needs — or should have — a second way to get at it.
 *
 * The two access-control definitions *are* exported, so tests can evaluate the
 * real role objects rather than a copy, and so the separation between the two
 * authorization domains is assertable from outside this folder.
 */
export { AppAuthModule } from './auth.module';
export { createAuthMailCallbacks } from './auth-mail';
export type { AppAuth } from './auth.factory';

export {
  DEFAULT_GLOBAL_ROLE,
  GLOBAL_ADMIN_ROLES,
  GLOBAL_PERMISSION_STATEMENTS,
  globalAccessControl,
  globalRoles,
} from './auth-access';
export type { GlobalRoleName } from './auth-access';

export {
  ORGANIZATION_CREATOR_ROLE,
  ORGANIZATION_PERMISSION_STATEMENTS,
  memberRoleHasPermission,
  organizationAccessControl,
  organizationRoles,
} from './organization-access';
export type { OrganizationRoleName } from './organization-access';

export {
  ACCOUNT_DEACTIVATED_CODE,
  GUARDED_ORGANIZATION_PATHS,
  ORGANIZATION_ARCHIVED_CODE,
} from './auth-hooks';

export { AccountLifecycleService } from './account-lifecycle.service';
export { OrganizationLifecycleService } from './organization-lifecycle.service';
