/**
 * Every route this application knows by name, in one place.
 *
 * All paths here are **locale-agnostic**. The locale prefix is applied by
 * `@/i18n/navigation`, so nothing in a feature ever writes `/ar/...` or
 * `/en/...` itself, and Next applies the mount point (`/platform`) from
 * `basePath`, so nothing writes that either. A path here is the same string the
 * App Router page represents beneath its locale segment.
 */

/** Public: reachable without a session, because a session is what they create. */
export const AUTH_ROUTES = {
  signIn: '/sign-in',
  signUp: '/sign-up',
  verifyEmail: '/verify-email',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
} as const;

export const PLATFORM_ROUTES = {
  /** Where an authenticated user lands when no better destination is known. */
  dashboard: '/',
  organizations: '/organizations',
  newOrganization: '/organizations/new',
  userSettings: '/settings',
  adminUsers: '/admin/users',
  controlPlane: '/admin/control-plane',
  designSystem: '/design-system',
} as const;

/** The tabs of one organization. Built from an id, so these are functions. */
export const ORGANIZATION_ROUTES = {
  overview: (id: string) => `/organizations/${encodeURIComponent(id)}`,
  members: (id: string) => `/organizations/${encodeURIComponent(id)}/members`,
  invitations: (id: string) =>
    `/organizations/${encodeURIComponent(id)}/invitations`,
  knowledge: (id: string) =>
    `/organizations/${encodeURIComponent(id)}/knowledge`,
  contentIdeas: (id: string) =>
    `/organizations/${encodeURIComponent(id)}/content-ideas`,
  contentProjects: (id: string) =>
    `/organizations/${encodeURIComponent(id)}/content-projects`,
  approvals: (id: string) =>
    `/organizations/${encodeURIComponent(id)}/approvals`,
  settings: (id: string) => `/organizations/${encodeURIComponent(id)}/settings`,
} as const;

/**
 * Routes below a tab, which are therefore not tabs.
 *
 * Kept out of `ORGANIZATION_ROUTES` deliberately. That object is the tab strip,
 * and its tests assert both directions of the relationship — every entry has a
 * tab, and every tab is an entry. A detail route has no tab, so putting it
 * there would mean loosening two assertions that are worth more than the
 * convenience of one namespace.
 */
export const ORGANIZATION_DETAIL_ROUTES = {
  contentProject: (id: string, projectId: string) =>
    `${ORGANIZATION_ROUTES.contentProjects(id)}/${encodeURIComponent(projectId)}`,
} as const;

/**
 * Public, but not an authentication route.
 *
 * The backend builds the invitation link as
 * `${APP_PLATFORM_URL}/<locale>/organizations/accept-invitation?id=<invitationId>`,
 * so this path and this query parameter are a contract with
 * `apps/backend/src/core/auth/auth-mail.ts` — they cannot be renamed on one
 * side alone.
 */
export const INVITATION_ROUTE = '/organizations/accept-invitation';
export const INVITATION_ID_PARAM = 'id';

/** Carries the interrupted destination through a sign-in. */
export const RETURN_TO_PARAM = 'returnTo';

/**
 * Never valid as a post-sign-in destination: returning to `/sign-in` after
 * signing in is the classic redirect loop.
 */
export const AUTHENTICATION_ONLY_PATHS: readonly string[] =
  Object.values(AUTH_ROUTES);

/**
 * Bounced away from when a session already exists.
 *
 * Only the two pages whose entire purpose is to create a session. The other
 * three are deliberately *not* here: a signed-in user may legitimately open
 * `/verify-email` (they signed up and have not confirmed yet) or follow a
 * `/reset-password` link from their mailbox, and bouncing them to the
 * dashboard would strand them.
 */
export const GUEST_ONLY_PATHS: readonly string[] = [
  AUTH_ROUTES.signIn,
  AUTH_ROUTES.signUp,
];

/** Reachable without a session. */
export const PUBLIC_PATHS: readonly string[] = [
  ...AUTHENTICATION_ONLY_PATHS,
  INVITATION_ROUTE,
];

/**
 * Path-prefix match, so `/reset-password` also covers any future
 * `/reset-password/expired` without this list growing a special case. Compares
 * segment boundaries rather than raw prefixes: `/sign-in-as-someone-else` is
 * not `/sign-in`.
 */
export function matchesPath(
  pathname: string,
  candidates: readonly string[],
): boolean {
  return candidates.some(
    (candidate) =>
      pathname === candidate || pathname.startsWith(`${candidate}/`),
  );
}
