import {
  adminClient,
  inferAdditionalFields,
  organizationClient,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { AUTH_BASE_PATH } from '@/config/paths';
import {
  globalAccessControl,
  globalRoles,
  organizationAccessControl,
  organizationRoles,
} from '@/features/authorization/permissions';

/**
 * The single Better Auth client for the platform.
 *
 * One instance, module-scoped: the client owns a nanostores session atom and a
 * broadcast channel that keeps tabs in sync, and a second instance would mean
 * two of each, silently disagreeing.
 *
 * `baseURL` is built from the page's own origin plus a fixed path, which is
 * what "same-origin" means in practice: production serves the API from
 * `/api/auth` on this very host, and development reproduces that through the
 * Vite proxy. There is no host to configure and no cross-origin request to
 * make, so the cookie is a plain first-party cookie and CORS never enters the
 * picture.
 *
 * It is stated explicitly rather than left to the library's default. Better
 * Auth's fallback consults environment variables first — including a generic
 * `BASE_URL`, which a bundler is entitled to define as `/platform/` — and a
 * path with no scheme would be rejected as an invalid base URL. Naming the
 * value removes that entire class of surprise.
 *
 * The two plugins are the client halves of the two the server runs. Passing
 * them the same access-control definitions is what makes
 * `admin.checkRolePermission` and `organization.checkRolePermission` answer the
 * same question the server would — locally, with no round trip, for UI
 * decisions only.
 */
export const authClient = createAuthClient({
  baseURL: new URL(AUTH_BASE_PATH, window.location.origin).toString(),
  plugins: [
    inferAdditionalFields({
      user: {
        preferredLanguage: { type: 'string', required: false },
      },
    }),
    adminClient({ ac: globalAccessControl, roles: globalRoles }),
    organizationClient({
      ac: organizationAccessControl,
      roles: organizationRoles,
    }),
  ],
});
