import { useCallback, useState } from 'react';

import { authClient } from '@/features/auth/auth-client';
import type { OrganizationSummary } from '@/features/auth/session-types';
import { useRevalidate } from '@/i18n/navigation';

import {
  type InvitationFailure,
  invitationFailureFrom,
} from '../invitation-state';

/**
 * Reads the organizations a user belongs to and changes which one is active.
 *
 * Both lists come from Better Auth's own reactive atoms, so a membership
 * gained by accepting an invitation shows up without this file knowing that
 * invitations exist.
 *
 * Switching is a server operation: `/organization/set-active` writes
 * `activeOrganizationId` onto the session row and re-issues the cookie. That
 * is why the refresh afterwards is required rather than tidy — every Server
 * Component that read the old active organization is now stale, and there is
 * no client state to update that would fix them.
 *
 * A failed switch is not cosmetic either. The backend clears the active
 * organization when the membership check fails, so the user really is now in
 * no organization, and the refresh makes the UI say so instead of continuing
 * to show the one they just failed to select.
 */
export function useOrganizationSwitcher() {
  const revalidate = useRevalidate();
  const organizations = authClient.useListOrganizations();
  const active = authClient.useActiveOrganization();

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<InvitationFailure | null>(null);

  const switchTo = useCallback(
    async (organizationId: string) => {
      setPendingId(organizationId);
      setFailure(null);

      try {
        const { error } = await authClient.organization.setActive({
          organizationId,
        });

        if (error) setFailure(invitationFailureFrom({ error }));
      } catch (thrown) {
        setFailure(invitationFailureFrom(thrown));
      } finally {
        setPendingId(null);
        revalidate();
      }
    },
    [revalidate],
  );

  return {
    organizations: (organizations.data ?? []) as OrganizationSummary[],
    activeOrganization: (active.data ?? null) as OrganizationSummary | null,
    isLoading: organizations.isPending,
    pendingId,
    failure,
    switchTo,
  };
}
