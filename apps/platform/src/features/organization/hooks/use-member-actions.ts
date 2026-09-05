import { useCallback, useState } from 'react';

import { authClient } from '@/features/auth/auth-client';
import type { OrganizationRoleName } from '@/features/authorization/permissions';
import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { useRouter } from '@/i18n/navigation';

import { useOrganizationAction } from './use-organization-action';

export function useMemberActions(input: {
  organizationId: string;
  currentUserId: string;
}) {
  const { organizationId, currentUserId } = input;

  const router = useRouter();
  const { error, reset, run } = useOrganizationAction();

  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null);

  const updateRole = useCallback(
    async (memberId: string, role: OrganizationRoleName) => {
      setPendingMemberId(memberId);

      const updated = await run(() =>
        authClient.organization.updateMemberRole({
          organizationId,
          memberId,
          role,
        }),
      );

      setPendingMemberId(null);

      if (updated) router.refresh();
    },
    [organizationId, router, run],
  );

  const removeMember = useCallback(
    async (memberId: string, userId: string) => {
      setPendingMemberId(memberId);

      const removed = await run(() =>
        authClient.organization.removeMember({
          organizationId,
          memberIdOrEmail: memberId,
        }),
      );

      setPendingMemberId(null);

      if (!removed) return;

      if (userId === currentUserId) {
        // No longer a member: this organization's pages will all refuse.
        router.replace(PLATFORM_ROUTES.organizations);
      }

      router.refresh();
    },
    [currentUserId, organizationId, router, run],
  );

  return { updateRole, removeMember, pendingMemberId, error, reset };
}
