import { GLOBAL_ROLE_GRANTS } from '@repo/authz-policy';

/**
 * Who counts as staff, answered from the shared policy rather than from a
 * list kept here.
 *
 * A global role is staff when the policy grants it at least one platform-wide
 * action. That is derived rather than declared on purpose: a role added to
 * `@repo/authz-policy` is classified by what it can do, so this surface and
 * the backend cannot come to disagree about who administers the installation.
 *
 * This is an entry gate and a presentation input. The backend authorizes
 * every administrative request itself and remains the authority; a screen
 * this predicate lets through is not a screen whose API calls are permitted.
 */
const KNOWN_ROLES: ReadonlySet<string> = new Set(Object.keys(GLOBAL_ROLE_GRANTS));

const STAFF_ROLES: ReadonlySet<string> = new Set(
  Object.entries(GLOBAL_ROLE_GRANTS)
    .filter(([, grants]) =>
      Object.values(grants as Record<string, readonly string[]>).some(
        (actions) => actions.length > 0,
      ),
    )
    .map(([role]) => role),
);

export const STAFF_ROLE_NAMES: readonly string[] = [...STAFF_ROLES].sort();

/**
 * Better Auth stores a principal's global roles as one comma-separated
 * string. Every name in it has to be one the policy knows, and at least one
 * has to be a staff role: a claim this application cannot evaluate is not a
 * claim it may act on, so an unrecognised name denies the whole set rather
 * than being ignored.
 */
export function isStaffRole(role: unknown): boolean {
  if (typeof role !== 'string') return false;

  const claimed = role
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (claimed.length === 0) return false;
  if (claimed.some((name) => !KNOWN_ROLES.has(name))) return false;

  return claimed.some((name) => STAFF_ROLES.has(name));
}

/**
 * The principal behind a session, if it is one this workspace admits. Default
 * deny: anything that is not a recognised staff claim on an account in good
 * standing is refused.
 */
export function isStaffPrincipal(user: unknown): boolean {
  if (typeof user !== 'object' || user === null) return false;

  const principal = user as { role?: unknown; banned?: unknown };

  // A suspended account keeps its role. It does not keep its access.
  if (principal.banned === true) return false;

  return isStaffRole(principal.role);
}
