/**
 * The authorization policy both applications answer from: which permissions
 * exist and which role holds which of them. The backend enforces it and stays
 * the authority; the platform reads it to predict what its UI should offer.
 * Defining it once is what keeps those two answers from drifting apart.
 *
 * This package holds policy only. Each application creates its own Better
 * Auth access control from these grants, and consumer-specific helpers —
 * assignable-role lists, default roles, permission request types — stay with
 * whichever application needs them.
 */
export type { PermissionStatements, RoleGrants } from './statements';

export { GLOBAL_APPLICATION_STATEMENTS, GLOBAL_ROLE_GRANTS } from './global';
export type { GlobalRoleName } from './global';

export {
  ORGANIZATION_PERMISSION_STATEMENTS,
  ORGANIZATION_ROLE_GRANTS,
} from './organization';
export type { OrganizationRoleName } from './organization';
