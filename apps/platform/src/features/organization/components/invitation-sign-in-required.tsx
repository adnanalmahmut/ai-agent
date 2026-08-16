import { buttonVariants } from '@repo/ui';
import { LogIn, Mail } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { MIRRORED_ICON } from '@/components/directional-icon';
import { AuthCard } from '@/features/auth/components/auth-card';
import { AUTH_ROUTES, RETURN_TO_PARAM } from '@/features/auth/routes';
import { Link } from '@/i18n/navigation';

/**
 * What an invited visitor sees before they have signed in.
 *
 * Not a redirect. Someone arriving from an email deserves to know why they
 * are being asked to sign in, and a bare bounce to a sign-in form reads as
 * the link having failed. The invitation URL is carried through as
 * `returnTo`, so accepting is one step away once they are in.
 *
 * It shows no organization name, no inviter, nothing — the backend requires a
 * session before it will say anything about an invitation, which is what
 * stops an invitation id from being a lookup key for anyone who finds it.
 */
export function InvitationSignInRequired({
  invitationPath,
}: {
  invitationPath: string;
}) {
  const t = useTranslations('Organization');

  return (
    <AuthCard
      title={t('invitation.signInRequiredTitle')}
      description={t('invitation.signInRequiredDescription')}
    >
      <div className="flex items-start gap-3 rounded-lg bg-muted p-4">
        <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm leading-6 text-muted-foreground">
          {t('invitation.signInRequiredHint')}
        </p>
      </div>

      <div className="space-y-2">
        <Link
          href={{
            pathname: AUTH_ROUTES.signIn,
            query: { [RETURN_TO_PARAM]: invitationPath },
          }}
          className={buttonVariants({ className: 'w-full' })}
        >
          <LogIn className={MIRRORED_ICON} />
          {t('invitation.signInAction')}
        </Link>

        <Link
          href={{
            pathname: AUTH_ROUTES.signUp,
            query: { [RETURN_TO_PARAM]: invitationPath },
          }}
          className={buttonVariants({
            variant: 'outline',
            className: 'w-full',
          })}
        >
          {t('invitation.signUpAction')}
        </Link>
      </div>
    </AuthCard>
  );
}
