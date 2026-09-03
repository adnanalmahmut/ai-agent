'use client';

import { Button } from '@repo/ui';
import { MailCheck, UserPlus } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useState } from 'react';

import { Link } from '@/i18n/navigation';

import { AuthCard } from '../components/auth-card';
import { AuthDivider } from '../components/auth-divider';
import { AuthErrorAlert } from '../components/auth-error-alert';
import { FormField } from '../components/form-field';
import { GoogleAuthButton } from '../components/google-auth-button';
import { PasswordField } from '../components/password-field';
import { SubmitButton } from '../components/submit-button';
import { useResendVerification } from '../hooks/use-email-verification';
import { useGoogleSignIn } from '../hooks/use-google-sign-in';
import { useSignUp } from '../hooks/use-sign-up';
import { AUTH_ROUTES, RETURN_TO_PARAM } from '../routes';
import { PASSWORD_MIN_LENGTH } from '../validation';

/**
 * Registration.
 *
 * The screen has two faces because the backend's flow has two steps: signing
 * up does not sign you in. With `requireEmailVerification` on, a successful
 * registration produces a user and an email, so the second face says so and
 * offers the only useful next action — send it again — rather than pretending
 * a dashboard is one click away.
 */
export function SignUpBlock({ returnTo }: { returnTo?: string }) {
  const t = useTranslations('Auth');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signUp = useSignUp();
  const google = useGoogleSignIn(returnTo);

  if (signUp.registeredEmail) {
    return <VerificationPending email={signUp.registeredEmail} />;
  }

  return (
    <AuthCard
      title={t('signUp.title')}
      description={t('signUp.description')}
      footer={
        <span className="flex flex-wrap items-center gap-1">
          {t('signUp.haveAccount')}
          <Link
            href={
              returnTo
                ? {
                    pathname: AUTH_ROUTES.signIn,
                    query: { [RETURN_TO_PARAM]: returnTo },
                  }
                : AUTH_ROUTES.signIn
            }
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('signUp.signInInstead')}
          </Link>
        </span>
      }
    >
      <AuthErrorAlert code={signUp.error ?? google.error} />

      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void signUp.submit({ name, email, password });
        }}
      >
        <FormField
          type="text"
          autoComplete="name"
          autoFocus
          required
          label={t('fields.name')}
          placeholder={t('fields.namePlaceholder')}
          value={name}
          issue={signUp.issues.name}
          onChange={(event) => {
            setName(event.target.value);
            signUp.reset();
          }}
        />

        <FormField
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          label={t('fields.email')}
          placeholder={t('fields.emailPlaceholder')}
          value={email}
          issue={signUp.issues.email}
          onChange={(event) => {
            setEmail(event.target.value);
            signUp.reset();
          }}
        />

        <PasswordField
          label={t('fields.password')}
          autoComplete="new-password"
          required
          value={password}
          issue={signUp.issues.password}
          hint={t('fields.passwordHint', { min: PASSWORD_MIN_LENGTH })}
          onChange={(value) => {
            setPassword(value);
            signUp.reset();
          }}
        />

        <SubmitButton isPending={signUp.isPending} icon={<UserPlus />}>
          {t('signUp.submit')}
        </SubmitButton>
      </form>

      <AuthDivider>{t('google.divider')}</AuthDivider>

      <GoogleAuthButton
        onStart={() => void google.start()}
        isPending={google.isPending}
        disabled={signUp.isPending}
      />
    </AuthCard>
  );
}

/**
 * The state a new account actually lands in.
 *
 * The address is echoed inside a `<bdi>`: an email is left-to-right text, and
 * without the isolation its punctuation reorders when it sits in an Arabic
 * sentence.
 */
function VerificationPending({ email }: { email: string }) {
  const t = useTranslations('Auth');
  const resend = useResendVerification(email);

  return (
    <AuthCard
      title={t('verifyEmail.pendingTitle')}
      description={t.rich('verifyEmail.pendingDescription', {
        email,
        address: (chunks) => (
          <bdi className="font-medium text-foreground">{chunks}</bdi>
        ),
      })}
      footer={
        <Link
          href={AUTH_ROUTES.signIn}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('verifyEmail.backToSignIn')}
        </Link>
      }
    >
      <div className="flex items-start gap-3 rounded-lg bg-muted p-4">
        <MailCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm leading-6 text-muted-foreground">
          {t('verifyEmail.pendingHint')}
        </p>
      </div>

      <AuthErrorAlert code={resend.error} />

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => void resend.submit()}
        disabled={resend.isPending || resend.isSent}
        aria-busy={resend.isPending}
      >
        {t(resend.isSent ? 'verifyEmail.resendSent' : 'verifyEmail.resend')}
      </Button>
    </AuthCard>
  );
}