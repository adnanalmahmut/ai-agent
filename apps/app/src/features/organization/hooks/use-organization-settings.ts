import { useCallback, useState } from 'react';

import { authClient } from '@/features/auth/auth-client';
import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { type FieldIssues, validate } from '@/features/auth/validation';
import { useRouter } from '@/i18n/navigation';

import { archiveOrganization, restoreOrganization } from '../organization-api';
import {
  type UpdateOrganizationValues,
  updateOrganizationSchema,
} from '../organization-validation';
import { useOrganizationAction } from './use-organization-action';

export function useUpdateOrganization(organizationId: string) {
  const router = useRouter();
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
      router.refresh();
    },
    [organizationId, router, run],
  );

  const clear = useCallback(() => {
    setIsSaved(false);
    reset();
  }, [reset]);

  return { submit, issues, error, isPending, isSaved, reset: clear };
}

export function useArchiveOrganization(organizationId: string) {
  const router = useRouter();
  const { isPending, error, reset, runThrowing } = useOrganizationAction();

  const submit = useCallback(
    async (reason?: string) => {
      const result = await runThrowing(() =>
        archiveOrganization(organizationId, reason),
      );

      if (!result) return;

      router.replace(PLATFORM_ROUTES.organizations);
    },
    [organizationId, router, runThrowing],
  );

  return { submit, error, isPending, reset };
}

export function useRestoreOrganization(organizationId: string) {
  const router = useRouter();
  const { isPending, error, reset, runThrowing } = useOrganizationAction();

  const submit = useCallback(async () => {
    const result = await runThrowing(() => restoreOrganization(organizationId));

    if (!result) return;

    router.refresh();
  }, [organizationId, router, runThrowing]);

  return { submit, error, isPending, reset };
}
