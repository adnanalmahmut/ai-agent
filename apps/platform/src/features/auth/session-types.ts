import type { authClient } from './auth-client';

/**
 * Session and user types, derived from the client rather than redeclared.
 *
 * Two fields cannot be inferred and are added by hand: the platform and
 * organization plugins are registered on the *server*, and the client plugins
 * declare `$InferServerPlugin: {}` because this application does not import
 * the backend's types. So `role` (admin plugin) and `activeOrganizationId`
 * (organization plugin) are stated here, optionally, once — and nowhere else.
 *
 * They are optional on purpose. A server that has not sent them yet must not
 * make this type a lie.
 */
type InferredSession = typeof authClient.$Infer.Session;

export type PlatformUser = InferredSession['user'] & {
  /** Global RBAC role. Never compared in a component — see the gates. */
  role?: string | null;
  banned?: boolean | null;
};

export type PlatformSessionRecord = InferredSession['session'] & {
  /**
   * Context, not permission.
   *
   * The backend treats an active organization as "which organization is this
   * request about", never as "this person may act on it" — a session can name
   * an organization the user is not a member of. The UI mirrors that: this
   * value picks what to show, and the member role decides what to enable.
   */
  activeOrganizationId?: string | null;
};

export type PlatformSession = {
  user: PlatformUser;
  session: PlatformSessionRecord;
};

/** Summary of an organization as the switcher and shell need it. */
export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
};
