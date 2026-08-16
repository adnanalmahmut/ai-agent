import { Alert, AlertDescription, AlertTitle } from '@repo/ui';
import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { ReactNode } from 'react';

import { type AuthErrorCode, authErrorMessageKey } from '../auth-errors';

/**
 * The single place an auth failure becomes visible text.
 *
 * It takes a normalised code, never a message, which is what stops a
 * provider's English string — or worse, a stack trace — reaching the screen.
 * An unrecognised code cannot happen: the type is a closed union and every
 * member has a translation in every locale, asserted by a test.
 *
 * `role="alert"` comes from the design system's Alert. The wrapper adds
 * `aria-live="assertive"` because the element is *inserted* after a failed
 * submit rather than being present and updated, and a screen reader needs to
 * be told that something appeared.
 */
export function AuthErrorAlert({
  code,
  action,
}: {
  code: AuthErrorCode | null;
  /** Optional recovery control, e.g. "resend the verification email". */
  action?: ReactNode;
}) {
  const t = useTranslations('Auth');

  return (
    <div aria-live="assertive" aria-atomic="true">
      {code ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t('errors.title')}</AlertTitle>
          <AlertDescription>
            <p>{t(authErrorMessageKey(code))}</p>
            {action}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
