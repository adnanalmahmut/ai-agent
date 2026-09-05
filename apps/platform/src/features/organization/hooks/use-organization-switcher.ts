import { useCallback, useState } from 'react';

import { authClient } from '@/features/auth/auth-client';
import type { OrganizationSummary } from '@/features/auth/session-types';
import { useRouter } from '@/i18n/navigation';

import {
  type InvitationFailure,
  invitationFailureFrom,
} from '../invitation-state';

export function useOrganizationSwitcher() {
  const router = useRouter();
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
        router.refresh();
      }
    },
    [router],
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
