import { useCallback, useState } from 'react';

import { authClient } from '@/features/auth/auth-client';
import type { OrganizationRoleName } from '@/features/authorization/permissions';
import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { useAppNavigate, useRevalidate } from '@/i18n/navigation';

import { useOrganizationAction } from './use-organization-action';

/**
 * Changing a member's role, and removing a member.
 *
 * One hook rather than two because the member list needs them together: both
 * act on a row, both need to know *which* row is busy so only that row's
 * controls disable, and both end in the same revalidation. Splitting them
 * would mean the table tracking two pending ids that can never both be set.
 *
 * The `currentUserId` parameter is what makes the self-removal case correct.
 * Removing yourself is a legitimate action the backend allows, and afterwards
 * every endpoint for that organization refuses you — so the reader has to be
 * navigated out rather than left on a members table that is about to fail to
 * reload. Nothing about that is an authorization decision: it is comparing an
 * id to an id, and the server had already agreed to the removal.
 */
export function useMemberActions(input: {
  organizationId: string;
  currentUserId: string;
}) {
  const { organizationId, currentUserId } = input;

  const navigate = useAppNavigate();
  const revalidate = useRevalidate();
  const { error, reset, run } = useOrganizationAction();

  /** The member row currently being acted on, so only it shows a spinner. */
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
