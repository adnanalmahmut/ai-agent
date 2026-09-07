import { Alert, AlertDescription, AlertTitle } from '@repo/ui';
import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { ReactNode } from 'react';

import { type AuthErrorCode, authErrorMessageKey } from '../auth-errors';

export function AuthErrorAlert({
  code,
  action,
}: {
  code: AuthErrorCode | null;
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
