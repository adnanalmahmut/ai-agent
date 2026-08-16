import { apiRequest } from '@/lib/application-api';

import type {
  ArchivedOrganization,
  OrganizationLifecycleResult,
} from './organization-types';

/**
 * The organization lifecycle, which belongs to this application rather than to
 * Better Auth.
 *
 * Archiving is not an authentication concept and Better Auth has no opinion
 * about it. It is a product decision — take an organization offline, keep
 * every row — that the backend implements on its own routes, so these three
 * calls go through the application API boundary rather than the auth client.
 *
 * Hard deletion is absent, and its absence is the design. The backend runs
 * with `disableOrganizationDeletion`, no role is granted `organization:delete`,
 * and there is no function here to call. Three independent locks on a door
 * this product does not have.
 */

const ORGANIZATIONS = '/organizations';

/** Takes an organization offline. Reversible; nothing is deleted. */
export function archiveOrganization(
  organizationId: string,
  reason?: string,
): Promise<OrganizationLifecycleResult> {
  return apiRequest(
    `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/archive`,
    { method: 'POST', body: reason ? { reason } : {} },
  );
}

/** Brings one back. */
export function restoreOrganization(
  organizationId: string,
): Promise<OrganizationLifecycleResult> {
  return apiRequest(
    `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/restore`,
    { method: 'POST' },
  );
}

/**
 * The archived organizations this caller can see.
 *
 * Needed because Better Auth's `/organization/list` deliberately hides them —
 * the backend filters archived organizations out of it so an archived
 * organization is invisible to every ordinary flow. That is correct, and it
 * leaves exactly one gap: without a separate read, an owner could archive an
 * organization and then have no way to find it again.
 *
 * The server decides who may restore each one and says so per row, so the UI
 * never has to work it out from a role.
 */
export function listArchivedOrganizations(
  signal?: AbortSignal,
): Promise<ArchivedOrganization[]> {
  return apiRequest(`${ORGANIZATIONS}/archived`, { signal });
}
