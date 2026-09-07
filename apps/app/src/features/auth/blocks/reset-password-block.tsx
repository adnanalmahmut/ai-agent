'use client';

import { Button, buttonVariants } from '@repo/ui';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useState } from 'react';

import { Link } from '@/i18n/navigation';

import { type AuthErrorCode, authErrorFromCallback } from '../auth-errors';
import { AuthCard } from '../components/auth-card';
import { AuthErrorAlert } from '../components/auth-error-alert';
import { PasswordField } from '../components/password-field';
import { SubmitButton } from '../components/submit-button';
import { useResetPassword } from '../hooks/use-password-reset';
import { AUTH_ROUTES } from '../routes';
import { PASSWORD_MIN_LENGTH } from '../validation';

export function ResetPasswordBlock({
  token,
  callbackError,
}: {
  token?: string;
  callbackError?: string;
}) {
  const t = useTranslations('Auth');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const reset = useResetPassword(token ?? null);

  const arrivalError: AuthErrorCode | null =
    authErrorFromCallback(callbackError) ?? (token ? null : 'INVALID_TOKEN');

  if (reset.isComplete) {
    return (
      <AuthCard
        title={t('resetPassword.doneTitle')}
        description={t('resetPassword.doneDescription')}
      >
        <div className="flex items-start gap-3 rounded-lg bg-muted p-4">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm leading-6 text-muted-foreground">
            {t('resetPassword.doneHint')}
          </p>
        </div>

        <Link
          href={AUTH_ROUTES.signIn}
          className={buttonVariants({ className: 'w-full' })}
        >
          {t('resetPassword.goToSignIn')}
        </Link>
      </AuthCard>
    );
  }

  if (arrivalError) {
    return (
      <AuthCard
        title={t('resetPassword.unusableTitle')}
        description={t('resetPassword.unusableDescription')}
      >
        <AuthErrorAlert code={arrivalError} />

        <Link
          href={AUTH_ROUTES.forgotPassword}
          className={buttonVariants({
            variant: 'outline',
            className: 'w-full',
          })}
        >
          {t('resetPassword.requestNew')}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('resetPassword.title')}
      description={t('resetPassword.description')}
      footer={
        <Button asChild variant="link" size="xs" className="px-0">
          <Link href={AUTH_ROUTES.signIn}>
            {t('resetPassword.backToSignIn')}
          </Link>
        </Button>
      }
    >
      <AuthErrorAlert code={reset.error} />

      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void reset.submit({ password, confirmPassword });
        }}
      >
        <PasswordField
          label={t('fields.newPassword')}
          autoComplete="new-password"
          autoFocus
          required
          value={password}
          issue={reset.issues.password}
          hint={t('fields.passwordHint', { min: PASSWORD_MIN_LENGTH })}
          onChange={(value) => {
            setPassword(value);
            reset.reset();
          }}
        />

        <PasswordField
          label={t('fields.confirmPassword')}
          autoComplete="new-password"
          required
          value={confirmPassword}
          issue={reset.issues.confirmPassword}
          onChange={(value) => {
            setConfirmPassword(value);
            reset.reset();
          }}
        />

        <SubmitButton isPending={reset.isPending} icon={<KeyRound />}>
          {t('resetPassword.submit')}
        </SubmitButton>
      </form>
    </AuthCard>
  );
}
