import { useCallback, useState } from 'react';

import { useRouter } from '@/i18n/navigation';

import { authClient } from '../auth-client';
import { PLATFORM_ROUTES } from '../routes';
import { safeReturnPath } from '../safe-return-url';
import {
  type FieldIssues,
  type SignInValues,
  signInSchema,
  validate,
} from '../validation';
import { useAuthAction } from './use-auth-action';

export type SignInInput = {
  email: string;
  password: string;
};

export function useSignIn(returnTo?: string | null) {
  const router = useRouter();
  const { isPending, error, reset, run } = useAuthAction();
  const [issues, setIssues] = useState<FieldIssues<SignInValues>>({});

  const [attemptedEmail, setAttemptedEmail] = useState('');

  const submit = useCallback(
    async (input: SignInInput) => {
      const parsed = validate(signInSchema, input);

      if (!parsed.ok) {
        setIssues(parsed.issues);
        return;
      }

      setIssues({});
      setAttemptedEmail(parsed.values.email);

      const result = await run(() =>
        authClient.signIn.email({
          email: parsed.values.email,
          password: parsed.values.password,
        }),
      );

      if (!result) return;

      const destination = safeReturnPath(returnTo, PLATFORM_ROUTES.dashboard);

      router.replace(destination);

      // Refresh the server layouts so the newly created session becomes the
      // authority for the protected tree before it renders.
      router.refresh();
    },
    [returnTo, router, run],
  );

  return { submit, issues, error, isPending, attemptedEmail, reset };
}
