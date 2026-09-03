'use client';

import { Alert, AlertDescription, AlertTitle, buttonVariants } from '@repo/ui';
import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { AuthCard } from '@/features/auth/components/auth-card';
import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { Link } from '@/i18n/navigation';

import {
  type InvitationFailure,
  invitationFailureKey,
} from '../invitation-state';

export function InvitationFailureCard({
  failure,
}: {
  failure: InvitationFailure;
}) {
  const t = useTranslations('Organization');

  return (
    <AuthCard
      title={t('invitation.unavailableTitle')}
      description={t('invitation.unavailableDescription')}
    >
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>{t('invitation.failureTitle')}</AlertTitle>
        <AlertDescription>
          <p>{t(`invitation.${invitationFailureKey(failure)}`)}</p>
        </AlertDescription>
      </Alert>

      <Link
        href={PLATFORM_ROUTES.dashboard}
        className={buttonVariants({ variant: 'outline', className: 'w-full' })}
      >
        {t('invitation.goToDashboard')}
      </Link>
    </AuthCard>
  );
}
