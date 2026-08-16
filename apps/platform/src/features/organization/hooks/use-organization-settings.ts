import { useCallback, useState } from 'react';

import { authClient } from '@/features/auth/auth-client';
import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { type FieldIssues, validate } from '@/features/auth/validation';
import { useAppNavigate, useRevalidate } from '@/i18n/navigation';

import { archiveOrganization, restoreOrganization } from '../organization-api';
import {
  type UpdateOrganizationValues,
  updateOrganizationSchema,
} from '../organization-validation';
import { useOrganizationAction } from './use-organization-action';

/**
 * Renaming an organization, or changing its slug.
 *
 * `isSaved` is reported rather than a toast being fired from in here: whether
 * success is a banner, an inline note or nothing at all is the block's
 * decision, and a hook that pushed UI would be making it for every future
 * caller.
 */
export function useUpdateOrganization(organizationId: string) {
  const revalidate = useRevalidate();
  const { isPending, error, reset, run } = useOrganizationAction();
  const [issues, setIssues] = useState<FieldIssues<UpdateOrganizationValues>>(
    {},
  );
  const [isSaved, setIsSaved] = useState(false);

  const submit = useCallback(
    async (input: { name: string; slug: string }) => {
      const parsed = validate(updateOrganizationSchema, input);

      if (!parsed.ok) {
        setIssues(parsed.issues);
        return;
      }

      setIssues({});
      setIsSaved(false);

      const updated = await run(() =>
        authClient.organization.update({
          organizationId,
          data: { name: parsed.values.name, slug: parsed.values.slug },
        }),
      );

      if (!updated) return;

      setIsSaved(true);
      revalidate();
    },
    [organizationId, revalidate, run],
  );

  const clear = useCallback(() => {
    setIsSaved(false);
    reset();
  }, [reset]);

  return { submit, issues, error, isPending, isSaved, reset: clear };
}

/**
 * Archiving an organization.
 *
 * Not a deletion, and the copy around this hook is careful to say so — members,
 * invitation history and every business resource survive. What the backend
 * actually does is mark the row, clear it from any session that had it
 * selected, and cancel its pending invitations, all in one transaction.
 *
 * Afterwards the reader is sent to the organizations list rather than left on
 * a page for an organization that every endpoint now refuses. Revalidating
 * first would only re-fetch a page we are about to leave, so the navigation
 * comes first and the list loads fresh on arrival.
 */
export function useArchiveOrganization(organizationId: string) {
  const navigate = useAppNavigate();
  const { isPending, error, reset, runThrowing } = useOrganizationAction();

  const submit = useCallback(
    async (reason?: string) => {
      const result = await runThrowing(() =>
        archiveOrganization(organizationId, reason),
      );

      if (!result) return;

      navigate(PLATFORM_ROUTES.organizations, { replace: true });
    },
    [navigate, organizationId, runThrowing],
  );

  return { submit, error, isPending, reset };
}

/**
 * Bringing an archived organization back.
 *
 * Authorized entirely by the server, which accepts either an owner holding
 * `organization:restore` or a platform operator holding the global
 * `organizationLifecycle:restore`. Nothing here compares a role — the UI only
 * ever offers the action when the archived list said this caller may use it,
 * and the endpoint decides again regardless.
 */
export function useRestoreOrganization(organizationId: string) {
  const revalidate = useRevalidate();
  const { isPending, error, reset, runThrowing } = useOrganizationAction();

  const submit = useCallback(async () => {
    const result = await runThrowing(() => restoreOrganization(organizationId));

    if (!result) return;

    revalidate();
  }, [organizationId, revalidate, runThrowing]);

  return { submit, error, isPending, reset };
}
