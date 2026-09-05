import { useCallback, useState } from 'react';

import { useAppLocale } from '@/i18n/use-app-locale';

import { authClient } from '../auth-client';
import { verificationCallbackUrl } from '../callback-urls';
import {
  type FieldIssues,
  type SignUpValues,
  signUpSchema,
  validate,
} from '../validation';
import { useAuthAction } from './use-auth-action';

export type SignUpInput = {
  name: string;
  email: string;
  password: string;
};

export function useSignUp() {
  const locale = useAppLocale();
  const { isPending, error, reset, run } = useAuthAction();
  const [issues, setIssues] = useState<FieldIssues<SignUpValues>>({});
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);

  const submit = useCallback(
    async (input: SignUpInput) => {
      const parsed = validate(signUpSchema, input);

      if (!parsed.ok) {
        setIssues(parsed.issues);
        return;
      }

      setIssues({});

      const result = await run(() =>
        authClient.signUp.email({
          name: parsed.values.name,
          email: parsed.values.email,
          password: parsed.values.password,
          // Points the verification link back at this application instead of
          // at the API host, and keeps the reader's language across the trip
          // through their mailbox.
          callbackURL: verificationCallbackUrl(locale, window.location.origin),
        }),
      );

      if (!result) return;

      setRegisteredEmail(parsed.values.email);
    },
    [locale, run],
  );

  return { submit, issues, error, isPending, registeredEmail, reset };
}
