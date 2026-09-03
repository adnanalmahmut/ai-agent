import { useCallback, useEffect, useRef, useState } from 'react';

import { authClient } from '@/features/auth/auth-client';
import { ORGANIZATION_ROUTES } from '@/features/auth/routes';
import { type FieldIssues, validate } from '@/features/auth/validation';
import { useAppNavigate, useRevalidate } from '@/i18n/navigation';

import {
  type CreateOrganizationValues,
  createOrganizationSchema,
} from '../organization-validation';
import { useOrganizationAction } from './use-organization-action';

const SLUG_CHECK_DELAY_MS = 400;

export type SlugAvailability = 'unknown' | 'checking' | 'available' | 'taken';

export function useCreateOrganization() {
  const navigate = useAppNavigate();
  const revalidate = useRevalidate();
  const { isPending, error, reset, run } = useOrganizationAction();
  const [issues, setIssues] = useState<FieldIssues<CreateOrganizationValues>>(
    {},
  );

  const submit = useCallback(
    async (input: { name: string; slug: string }) => {
      const parsed = validate(createOrganizationSchema, input);

      if (!parsed.ok) {
        setIssues(parsed.issues);
        return;
      }

      setIssues({});

      const created = await run(() =>
        authClient.organization.create({
          name: parsed.values.name,
          slug: parsed.values.slug,
          keepCurrentActiveOrganization: false,
        }),
      );

      if (!created) return;

      revalidate();
      navigate(ORGANIZATION_ROUTES.overview(created.id), { replace: true });
    },
    [navigate, revalidate, run],
  );

  return { submit, issues, error, isPending, reset };
}

export function useSlugAvailability(
  slug: string,
  enabled: boolean,
): SlugAvailability {
  const [answer, setAnswer] = useState<{
    slug: string;
    status: 'available' | 'taken';
  } | null>(null);

  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled || slug.length === 0) return;

    const id = ++requestId.current;

    const timer = setTimeout(() => {
      void authClient.organization
        .checkSlug({ slug })
        .then(({ data, error }) => {
          // A newer keystroke has already started its own request; this
          // answer is about a slug the reader has moved on from.
          if (id !== requestId.current) return;

          // A failed check is not a taken slug. Saying nothing is better than
          // telling the reader their slug is unavailable because the network
          // hiccuped.
          if (error) return;

          setAnswer({ slug, status: data?.status ? 'available' : 'taken' });
        })
        .catch(() => {
          // Same reasoning: silence, not a false negative.
        });
    }, SLUG_CHECK_DELAY_MS);

    return () => clearTimeout(timer);
  }, [enabled, slug]);

  // Derived rather than stored. Keeping a `status` in state and writing
  // `'checking'` into it from the effect would mean two sources of truth for
  // one question, and a render where they disagree.
  if (!enabled || slug.length === 0) return 'unknown';
  if (answer?.slug === slug) return answer.status;

  return 'checking';
}
