import { useCallback, useState } from 'react';

import { authClient } from '@/features/auth/auth-client';
import type { OrganizationRoleName } from '@/features/authorization/permissions';
import { type FieldIssues, validate } from '@/features/auth/validation';
import { useRevalidate } from '@/i18n/navigation';

import {
  type InviteMemberValues,
  inviteMemberSchema,
} from '../organization-validation';
import { useOrganizationAction } from './use-organization-action';

/**
 * Inviting someone to an organization.
 *
 * `resend: true` is passed on every call, and it is what makes "invite again"
 * work without a second endpoint. Better Auth has no resend route; re-inviting
 * an address that already has a pending invitation is the resend, and the
 * backend is configured with `cancelPendingInvitationsOnReInvite` so the old
 * one stops working the moment a new one is sent. Inventing a `resend`
 * endpoint to match a nicer-sounding UI would have meant calling something
 * that does not exist.
 *
 * What the reader is told afterwards is deliberately thin. The invitation is
 * created whether or not the address belongs to an account, and the backend
 * does not restore a deactivated one — so the confirmation says an invitation
 * was sent and nothing about who, if anyone, is on the other end.
 */
export function useInviteMember(organizationId: string) {
  const revalidate = useRevalidate();
  const { isPending, error, reset, run } = useOrganizationAction();
  const [issues, setIssues] = useState<FieldIssues<InviteMemberValues>>({});
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);

  const submit = useCallback(
    async (input: { email: string; role: OrganizationRoleName }) => {
      const parsed = validate(inviteMemberSchema, { email: input.email });

      if (!parsed.ok) {
        setIssues(parsed.issues);
        return;
      }

      setIssues({});
      setInvitedEmail(null);

      const invitation = await run(() =>
        authClient.organization.inviteMember({
          organizationId,
          email: parsed.values.email,
          role: input.role,
          resend: true,
        }),
      );

      if (!invitation) return;

      setInvitedEmail(parsed.values.email);
      revalidate();
    },
    [organizationId, revalidate, run],
  );

  const clear = useCallback(() => {
    setInvitedEmail(null);
    setIssues({});
    reset();
  }, [reset]);

  return { submit, issues, error, isPending, invitedEmail, reset: clear };
}

/**
 * Withdrawing an invitation that has not been accepted.
 *
 * The row disappears from the pending list, but the invitation is *cancelled*
 * rather than deleted — the backend keeps the history of who was invited, and
 * the invitations page shows it. That is why the copy says withdrawn and not
 * removed.
 */
export function useCancelInvitation() {
  const revalidate = useRevalidate();
  const { error, reset, run } = useOrganizationAction();
  const [pendingInvitationId, setPendingInvitationId] = useState<string | null>(
    null,
  );

  const cancel = useCallback(
    async (invitationId: string) => {
      setPendingInvitationId(invitationId);

      const cancelled = await run(() =>
        authClient.organization.cancelInvitation({ invitationId }),
      );

      setPendingInvitationId(null);

      if (cancelled) revalidate();
    },
    [revalidate, run],
  );

  return { cancel, pendingInvitationId, error, reset };
}
