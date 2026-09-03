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

/** How long the reader has to stop typing before the slug is checked. */
const SLUG_CHECK_DELAY_MS = 400;

export type SlugAvailability = 'unknown' | 'checking' | 'available' | 'taken';

/**
 * Creating an organization.
 *
 * Three things happen on success and the order matters. The backend makes the
 * creator an owner and, because `organization.create` sets it, the new
 * organization becomes the session's active one — both server-side, neither
 * visible to data already loaded. So the App Router data is refreshed, and
 * then the reader is taken into the organization they just made.
 */
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

/**
 * Tells the reader whether a slug is free, before they submit.
 *
 * A courtesy, not a check. The server enforces uniqueness on write and a slug
 * can be taken between this answer and that write, so `available` means "was
 * free a moment ago" and the form does not use it to decide anything. What it
 * buys is not having to fill in a form twice.
 *
 * Debounced, aborted on change, and ordered: a stale response that arrives
 * after a newer request is discarded rather than overwriting it, which is the
 * bug this shape exists to avoid.
 */
export function useSlugAvailability(
  slug: string,
  enabled: boolean,
): SlugAvailability {
  /** The last answer, and which slug it was about. */
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
