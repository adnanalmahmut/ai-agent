import { adminClient, organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { publicConfig } from '@/config/public';

/**
 * Better Auth client.
 *
 * The minimum needed for the backend's capabilities to be reachable later —
 * no components, no pages, no sign-in button. The two plugins are added now
 * because they are the client counterparts of the admin and organization
 * plugins the server already runs, and adding them later would mean revisiting
 * every call site that had worked around their absence.
 *
 * Anything this client reports about roles or permissions is **UX only**.
 * `authClient.admin.hasPermission` and `organization.hasPermission` exist to
 * decide whether to render a button, never whether an action is allowed: the
 * server re-derives every decision from the database on the request itself.
 */
export const authClient = createAuthClient({
  baseURL: publicConfig.apiUrl,
  plugins: [adminClient(), organizationClient()],
});
