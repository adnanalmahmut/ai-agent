import { Alert, AlertDescription, AlertTitle } from '@repo/ui';
import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';

import {
  type OrganizationError,
  organizationErrorKey,
} from '../organization-errors';

export function OrganizationErrorAlert({
  error,
  action,
}: {
  error: OrganizationError | null;
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
