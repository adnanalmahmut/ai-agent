'use client';

import { buttonVariants } from '@repo/ui';
import { CheckCircle2, MailCheck } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useState } from 'react';

import { Link } from '@/i18n/navigation';

import { authErrorFromCallback } from '../auth-errors';
import { AuthCard } from '../components/auth-card';
import { AuthErrorAlert } from '../components/auth-error-alert';
import { FormField } from '../components/form-field';
import { SubmitButton } from '../components/submit-button';
import { useResendVerification } from '../hooks/use-email-verification';
import { AUTH_ROUTES } from '../routes';

export function VerifyEmailBlock({
  isVerified,
  callbackError,
}: {
  isVerified: boolean;
  callbackError?: string;
}) {
  const t = useTranslations('Auth');
  const [email, setEmail] = useState('');
  const resend = useResendVerification();

  const arrivalError = authErrorFromCallback(callbackError);

  if (isVerified && !arrivalError) {
    return (
      <AuthCard
        title={t('verifyEmail.successTitle')}
        description={t('verifyEmail.successDescription')}
      >
        <div className="flex items-start gap-3 rounded-lg bg-muted p-4">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm leading-6 text-muted-foreground">
            {t('verifyEmail.successHint')}
          </p>
        </div>

        <Link
          href={AUTH_ROUTES.signIn}
          className={buttonVariants({ className: 'w-full' })}
        >
          {t('verifyEmail.goToSignIn')}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t(
        arrivalError ? 'verifyEmail.failedTitle' : 'verifyEmail.pendingTitle',
      )}
      description={t(
        arrivalError
          ? 'verifyEmail.failedDescription'
          : 'verifyEmail.standaloneDescription',
      )}
      footer={
        <Link
          href={AUTH_ROUTES.signIn}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('verifyEmail.backToSignIn')}
        </Link>
      }
    >
      <AuthErrorAlert code={arrivalError ?? resend.error} />

      {resend.isSent ? (
        <div className="flex items-start gap-3 rounded-lg bg-muted p-4">
          <MailCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm leading-6 text-muted-foreground">
            {t('verifyEmail.resendConfirmation')}
          </p>
        </div>
      ) : (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void resend.submit({ email });
          }}
        >
          <FormField
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            label={t('fields.email')}
            placeholder={t('fields.emailPlaceholder')}
            value={email}
            issue={resend.issues.email}
            onChange={(event) => {
              setEmail(event.target.value);
              resend.reset();
            }}
          />

          <SubmitButton isPending={resend.isPending} icon={<MailCheck />}>
            {t('verifyEmail.resend')}
          </SubmitButton>
        </form>
      )}
    </AuthCard>
  );
}
