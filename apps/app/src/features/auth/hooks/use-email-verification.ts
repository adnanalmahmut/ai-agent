import { useCallback, useState } from 'react';

import { useAppLocale } from '@/i18n/use-app-locale';

import { authClient } from '../auth-client';
import { verificationCallbackUrl } from '../callback-urls';
import {
  type FieldIssues,
  resendVerificationSchema,
  validate,
} from '../validation';
import { useAuthAction } from './use-auth-action';

type ResendValues = { email: string };

export function useResendVerification(initialEmail = '') {
  const locale = useAppLocale();
  const { isPending, error, reset, run } = useAuthAction();
  const [issues, setIssues] = useState<FieldIssues<ResendValues>>({});
  const [isSent, setIsSent] = useState(false);

  const submit = useCallback(
    async (input: { email?: string } = {}) => {
      const email = input.email ?? initialEmail;
      const parsed = validate(resendVerificationSchema, { email });

      if (!parsed.ok) {
        setIssues(parsed.issues);
        return;
      }

      setIssues({});
      setIsSent(false);

      const result = await run(() =>
        authClient.sendVerificationEmail({
          email: parsed.values.email,
          callbackURL: verificationCallbackUrl(locale, window.location.origin),
        }),
      );

      if (result) setIsSent(true);
    },
    [initialEmail, locale, run],
  );

  return { submit, issues, error, isPending, isSent, reset };
}
