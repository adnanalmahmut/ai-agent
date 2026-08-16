import { useOutletContext } from 'react-router';

import type { FullOrganization, OrganizationMember } from './organization-types';

/**
 * What the four organization tabs are handed by their layout.
 *
 * Passed through `<Outlet context>` rather than read from the loader again,
 * and rather than put in a React context of its own. Three properties fall out
 * of that choice:
 *
 * The layout has already narrowed the loader's union — a tab can only render
 * when the organization loaded, so none of them carries a branch for
 * "archived" or "failed". That is why this type has no optional fields.
 *
 * `viewer.member` is the reader's membership **in this organization**, not in
 * whichever one is active. Every permission decision on these pages is made
 * from it, which is what stops a reader who has organization A selected from
 * being shown organization B's controls.
 *
 * And it is scoped: nothing outside the organization routes can reach it, so
 * it cannot become the general-purpose `PlatformContext` the architecture is
 * trying not to grow.
 */
export type OrganizationContext = {
  organization: FullOrganization;
  viewer: {
    userId: string;
    /** `null` should be impossible — the endpoint refuses non-members. */
    member: OrganizationMember | null;
  };
};

export function useOrganizationContext(): OrganizationContext {
  return useOutletContext<OrganizationContext>();
}
