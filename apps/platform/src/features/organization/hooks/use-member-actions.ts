import { useCallback, useState } from 'react';

import { authClient } from '@/features/auth/auth-client';
import type { OrganizationRoleName } from '@/features/authorization/permissions';
import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { useAppNavigate, useRevalidate } from '@/i18n/navigation';

import { useOrganizationAction } from './use-organization-action';

export function useMemberActions(input: {
  organizationId: string;
  currentUserId: string;
}) {
  const { organizationId, currentUserId } = input;

  const navigate = useAppNavigate();
  const revalidate = useRevalidate();
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

      if (updated) revalidate();
    },
    [organizationId, revalidate, run],
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
        navigate(PLATFORM_ROUTES.organizations, { replace: true });
      }

      revalidate();
    },
    [currentUserId, navigate, organizationId, revalidate, run],
  );

  return { updateRole, removeMember, pendingMemberId, error, reset };
}
