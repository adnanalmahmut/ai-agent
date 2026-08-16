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

/**
 * Every way an invitation can fail to open, in one screen.
 *
 * A Server Component, because the failure is already known by the time the
 * page renders — there is nothing to interact with and nothing to wait for.
 *
 * The copy is per-failure rather than generic. "This invitation is no longer
 * valid" and "you are signed in as someone else" call for different actions,
 * and collapsing them into one apologetic sentence leaves the user with
 * nothing to do.
 */
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
