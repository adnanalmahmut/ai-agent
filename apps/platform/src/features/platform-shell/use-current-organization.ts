import { useRouteLoaderData } from 'react-router';

import { authClient } from '@/features/auth/auth-client';
import type { OrganizationData } from '@/features/organization/loaders';
import { ORGANIZATION_ROUTE_ID } from '@/features/organization/loaders';

export type CurrentOrganization = {
  id: string;
  name: string;
};

/**
 * Which organization the sidebar should be showing sections for.
 *
 * Two sources, in that order, and the order is the point.
 *
 * If the reader is *on* an organization page, that organization is the one in
 * context — even if a different one is the session's active organization.
 * Showing the active one's sections while reading another organization's
 * members would be a navigation that lies about where its links go.
 *
 * Otherwise the active organization is the best available answer: it is what
 * the switcher says, and what the backend will assume for anything that does
 * not name an organization.
 *
 * Neither source is an authorization decision. This picks what to *show*; the
 * permission checks on each page decide what may be done, and the server
 * decides again.
 */
export function useCurrentOrganization(): CurrentOrganization | null {
  const routeData =
    useRouteLoaderData<OrganizationData>(ORGANIZATION_ROUTE_ID);

  const active = authClient.useActiveOrganization();

  if (routeData?.state === 'ready') {
    return {
      id: routeData.organization.id,
      name: routeData.organization.name,
    };
  }

  if (active.data) {
    return { id: active.data.id, name: active.data.name };
  }

  return null;
}
