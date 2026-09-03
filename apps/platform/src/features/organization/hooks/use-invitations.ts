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
