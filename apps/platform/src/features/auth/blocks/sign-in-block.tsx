import { Button } from '@repo/ui';
import { LogIn } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useState } from 'react';

import { MIRRORED_ICON } from '@/components/directional-icon';
import { Link } from '@/i18n/navigation';

import { type AuthErrorCode, authErrorFromCallback } from '../auth-errors';
import { AuthCard } from '../components/auth-card';
import { AuthDivider } from '../components/auth-divider';
import { AuthErrorAlert } from '../components/auth-error-alert';
import { FormField } from '../components/form-field';
import { GoogleAuthButton } from '../components/google-auth-button';
import { PasswordField } from '../components/password-field';
import { SubmitButton } from '../components/submit-button';
import { useResendVerification } from '../hooks/use-email-verification';
import { useGoogleSignIn } from '../hooks/use-google-sign-in';
import { useSignIn } from '../hooks/use-sign-in';
import { AUTH_ROUTES, RETURN_TO_PARAM } from '../routes';

/**
 * The sign-in experience.
 *
 * Composition only: the form's state and the decision about where a
 * successful sign-in leads both live in `useSignIn`, so this file can be read
 * as a description of the screen.
 *
 * The one piece of logic it does own is which error to show, because three
 * can arrive at once — the password attempt, the Google attempt, and an
 * `?error=` left by a Google redirect that failed before the page loaded.
 */
export function SignInBlock({
  returnTo,
  providerError,
}: {
  returnTo?: string;
  providerError?: string;
}) {
  const t = useTranslations('Auth');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useSignIn(returnTo);
  const google = useGoogleSignIn(returnTo);
  const resend = useResendVerification(signIn.attemptedEmail);

  const [dismissedProviderError, setDismissedProviderError] = useState(false);

  const error: AuthErrorCode | null =
    signIn.error ??
    google.error ??
    (dismissedProviderError ? null : authErrorFromCallback(providerError));

  const isBusy = signIn.isPending || google.isPending;

  function clearErrors() {
    signIn.reset();
    google.reset();
    setDismissedProviderError(true);
  }

  return (
    <AuthCard
      title={t('signIn.title')}
      description={t('signIn.description')}
      footer={
        <span className="flex flex-wrap items-center gap-1">
          {t('signIn.noAccount')}
          <Link
            href={
              returnTo
                ? {
                    pathname: AUTH_ROUTES.signUp,
                    query: { [RETURN_TO_PARAM]: returnTo },
                  }
                : AUTH_ROUTES.signUp
            }
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('signIn.createAccount')}
          </Link>
        </span>
      }
    >
      <AuthErrorAlert
        code={error}
        action={
          error === 'EMAIL_NOT_VERIFIED' && signIn.attemptedEmail ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="px-0 text-destructive"
              onClick={() => void resend.submit()}
              disabled={resend.isPending || resend.isSent}
            >
              {t(
                resend.isSent
                  ? 'verifyEmail.resendSent'
                  : 'verifyEmail.resendAction',
              )}
            </Button>
          ) : null
        }
      />

      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void signIn.submit({ email, password });
        }}
      >
        <FormField
          type="email"
          inputMode="email"
          autoComplete="email"
          autoFocus
          required
          label={t('fields.email')}
          placeholder={t('fields.emailPlaceholder')}
          value={email}
          issue={signIn.issues.email}
          onChange={(event) => {
            setEmail(event.target.value);
            clearErrors();
          }}
        />

        <div className="space-y-2">
          <PasswordField
            label={t('fields.password')}
            autoComplete="current-password"
            required
            value={password}
            issue={signIn.issues.password}
            onChange={(value) => {
              setPassword(value);
              clearErrors();
            }}
          />

          <div className="flex justify-end">
            <Link
              href={AUTH_ROUTES.forgotPassword}
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {t('signIn.forgotPassword')}
            </Link>
          </div>
        </div>

        <SubmitButton isPending={signIn.isPending} icon={<LogIn className={MIRRORED_ICON} />}>
          {t('signIn.submit')}
        </SubmitButton>
      </form>

      <AuthDivider>{t('google.divider')}</AuthDivider>

      <GoogleAuthButton
        onStart={() => void google.start()}
        isPending={google.isPending}
        disabled={isBusy}
      />
    </AuthCard>
  );
}
