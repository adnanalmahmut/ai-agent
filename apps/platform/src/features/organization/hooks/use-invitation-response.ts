import { useCallback, useState } from 'react';

import { authClient } from '@/features/auth/auth-client';
import { ORGANIZATION_ROUTES, PLATFORM_ROUTES } from '@/features/auth/routes';
import { useRouter } from '@/i18n/navigation';

import {
  type InvitationFailure,
  invitationFailureFrom,
} from '../invitation-state';

export function useInvitationResponse(invitationId: string) {
  const router = useRouter();
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

          router.replace(PLATFORM_ROUTES.organizations);
          router.refresh();
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

        router.replace(
          organizationId
            ? ORGANIZATION_ROUTES.overview(organizationId)
            : PLATFORM_ROUTES.organizations,
        );
        router.refresh();
      } catch (thrown) {
        setFailure(invitationFailureFrom(thrown));
      } finally {
        setPending(null);
      }
    },
    [invitationId, router],
  );

  return {
    accept: () => respond('accept'),
    reject: () => respond('reject'),
    pending,
    failure,
    isAccepted,
  };
}
