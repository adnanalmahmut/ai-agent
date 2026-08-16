import { Alert, AlertDescription, AlertTitle } from '@repo/ui';
import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';

import {
  type OrganizationError,
  organizationErrorKey,
} from '../organization-errors';

/**
 * The single place an organization failure becomes visible text.
 *
 * It takes a normalised code, never a message, which is what stops a
 * provider's English string — or worse, a stack trace — reaching the screen.
 * An unrecognised code cannot happen: the type is a closed union and every
 * member has a translation in every locale, asserted by a test.
 *
 * `aria-live="assertive"` because the alert is *inserted* after a failed
 * action rather than being present and updated, and a screen reader has to be
 * told that something appeared.
 */
export function OrganizationErrorAlert({
  error,
  action,
}: {
  error: OrganizationError | null;
  /** Optional recovery control, e.g. "try again". */
  action?: ReactNode;
}) {
  const t = useTranslations('Organization');

  return (
    <div aria-live="assertive" aria-atomic="true">
      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t('errors.title')}</AlertTitle>
          <AlertDescription>
            <p>{t(organizationErrorKey(error))}</p>
            {action}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
