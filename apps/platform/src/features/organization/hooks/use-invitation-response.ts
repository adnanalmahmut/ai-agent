import { useCallback, useState } from 'react';

import { authClient } from '@/features/auth/auth-client';
import { ORGANIZATION_ROUTES, PLATFORM_ROUTES } from '@/features/auth/routes';
import { useAppNavigate, useRevalidate } from '@/i18n/navigation';

import {
  type InvitationFailure,
  invitationFailureFrom,
} from '../invitation-state';

/**
 * Accepting or declining an invitation.
 *
 * Both are one call plus one navigation, but they share enough state —
 * pending, failure, which action is running — that keeping them out of the
 * block is what lets the block stay a description of a screen.
 *
 * Accepting changes two things the platform displays: the user gains a
 * membership, and the backend makes the new organization active in the same
 * transaction. Neither is visible to Server Component data already in hand,
 * so refreshing is not optional here — without it the shell would keep
 * showing the previous organization until a hard reload.
 *
 * On success the reader is taken *into* the organization they just joined
 * rather than to the dashboard. They followed a link about one specific
 * organization; landing anywhere else makes them go looking for it.
 */
export function useInvitationResponse(invitationId: string) {
  const navigate = useAppNavigate();
  const revalidate = useRevalidate();
  const [pending, setPending] = useState<'accept' | 'reject' | null>(null);
  const [failure, setFailure] = useState<InvitationFailure | null>(null);
  const [isAccepted, setIsAccepted] = useState(false);

  const respond = useCallback(
    async (action: 'accept' | 'reject') => {
      setPending(action);
      setFailure(null);

      try {
        if (action === 'reject') {
          const { error } = await authClient.organization.rejectInvitation({
            invitationId,
          });

          if (error) {
            setFailure(invitationFailureFrom({ error }));
            return;
          }

          navigate(PLATFORM_ROUTES.organizations, { replace: true });
          revalidate();
          return;
        }

        const { data, error } = await authClient.organization.acceptInvitation({
          invitationId,
        });

        if (error) {
          setFailure(invitationFailureFrom({ error }));
          return;
        }

        setIsAccepted(true);

        // The membership row names the organization authoritatively. If the
        // response ever stops carrying one, the organizations list is the
        // honest fallback — it will contain the new organization either way.
        const organizationId = data?.member?.organizationId;

        navigate(
          organizationId
            ? ORGANIZATION_ROUTES.overview(organizationId)
            : PLATFORM_ROUTES.organizations,
          { replace: true },
        );
        revalidate();
      } catch (thrown) {
        setFailure(invitationFailureFrom(thrown));
      } finally {
        setPending(null);
      }
    },
    [invitationId, navigate, revalidate],
  );

  return {
    accept: () => respond('accept'),
    reject: () => respond('reject'),
    pending,
    failure,
    isAccepted,
  };
}
