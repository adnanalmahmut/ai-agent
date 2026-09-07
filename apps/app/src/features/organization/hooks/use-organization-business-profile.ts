import { useCallback, useState } from 'react';

import { type FieldIssues, validate } from '@/features/auth/validation';
import { useRouter } from '@/i18n/navigation';

import { replaceOrganizationBusinessProfile } from '../organization-api';
import type { OrganizationBusinessProfile } from '../organization-types';
import {
  organizationBusinessProfileSchema,
  type OrganizationBusinessProfileValues,
} from '../organization-validation';
import { useOrganizationAction } from './use-organization-action';

export type BusinessProfileFormValues = {
  version: number;
  locale: 'ar' | 'en';
  timezone: string;
  currency: string;
  legalName: string;
  industry: string;
  websiteUrl: string;
  businessDescription: string;
};

export function formValuesFromProfile(
  profile: OrganizationBusinessProfile,
): BusinessProfileFormValues {
  return {
    version: profile.version,
    locale: profile.locale,
    timezone: profile.timezone,
    currency: profile.currency,
    legalName: profile.legalName ?? '',
    industry: profile.industry ?? '',
    websiteUrl: profile.websiteUrl ?? '',
    businessDescription: profile.businessDescription ?? '',
  };
}

export function useOrganizationBusinessProfile(organizationId: string) {
  const router = useRouter();
  const { isPending, error, reset, runThrowing } = useOrganizationAction();
  const [issues, setIssues] = useState<
    FieldIssues<OrganizationBusinessProfileValues>
  >({});
  const [isSaved, setIsSaved] = useState(false);

  const submit = useCallback(
    async (input: BusinessProfileFormValues) => {
      const parsed = validate(organizationBusinessProfileSchema, input);

      if (!parsed.ok) {
        setIssues(parsed.issues);
        return;
      }

      setIssues({});
      setIsSaved(false);

      const updated = await runThrowing(() =>
        replaceOrganizationBusinessProfile(organizationId, parsed.values),
      );

      if (!updated) return;

      setIsSaved(true);
      router.refresh();
    },
    [organizationId, router, runThrowing],
  );

  const clear = useCallback(() => {
    setIsSaved(false);
    reset();
  }, [reset]);

  return { submit, issues, error, isPending, isSaved, reset: clear };
}
