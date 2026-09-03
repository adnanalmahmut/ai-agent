'use client';

import { MailCheck, Send } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useState } from 'react';

import { MIRRORED_ICON } from '@/components/directional-icon';
import { Link } from '@/i18n/navigation';

import { AuthCard } from '../components/auth-card';
import { AuthErrorAlert } from '../components/auth-error-alert';
import { FormField } from '../components/form-field';
import { SubmitButton } from '../components/submit-button';
import { useRequestPasswordReset } from '../hooks/use-password-reset';
import { AUTH_ROUTES } from '../routes';

/**
 * Requests a reset link.
 *
 * The success state deliberately says nothing about whether the address is
 * registered. The backend is careful about this — it does the same work on a
 * miss so the response time does not give the answer away — and a UI that
 * said "no such account" would hand back the account-existence oracle the
 * backend just refused to be.
 *
 * Which means the confirmation is worded as a conditional, and the same
 * screen appears either way.
 */
export function ForgotPasswordBlock() {
  const t = useTranslations('Auth');
  const [email, setEmail] = useState('');
  const request = useRequestPasswordReset();

  const backToSignIn = (
    <Link
      href={AUTH_ROUTES.signIn}
      className="font-medium text-primary underline-offset-4 hover:underline"
    >
      {t('forgotPassword.backToSignIn')}
    </Link>
  );

  if (request.isSent) {
    return (
      <AuthCard
        title={t('forgotPassword.sentTitle')}
        description={t('forgotPassword.sentDescription')}
        footer={backToSignIn}
      >
        <div className="flex items-start gap-3 rounded-lg bg-muted p-4">
          <MailCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm leading-6 text-muted-foreground">
            {t('forgotPassword.sentHint')}
          </p>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('forgotPassword.title')}
      description={t('forgotPassword.description')}
      footer={backToSignIn}
    >
      <AuthErrorAlert code={request.error} />

      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void request.submit({ email });
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
          issue={request.issues.email}
          onChange={(event) => {
            setEmail(event.target.value);
            request.reset();
          }}
        />

        <SubmitButton
          isPending={request.isPending}
          icon={<Send className={MIRRORED_ICON} />}
        >
          {t('forgotPassword.submit')}
        </SubmitButton>
      </form>
    </AuthCard>
  );
}