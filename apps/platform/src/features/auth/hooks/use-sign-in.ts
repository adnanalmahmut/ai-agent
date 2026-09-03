import { useCallback, useState } from 'react';

import { useAppNavigate, useRevalidate } from '@/i18n/navigation';

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

/**
 * Everything the sign-in form does that is not rendering.
 *
 * Client validation, the Better Auth call, error normalisation and the
 * post-success navigation live here so `SignInBlock` can be a form that
 * displays state. The split is worth its own file because this hook holds
 * five pieces of state and decides where the user goes next; inlining it
 * would put a redirect policy inside a component.
 */
export function useSignIn(returnTo?: string | null) {
  const navigate = useAppNavigate();
  const revalidate = useRevalidate();
  const { isPending, error, reset, run } = useAuthAction();
  const [issues, setIssues] = useState<FieldIssues<SignInValues>>({});

  /**
   * Remembered so the "email not verified" state can offer to resend without
   * asking the user to type their address a second time.
   */
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

      navigate(destination, { replace: true });

      // Refresh the server layouts so the newly created session becomes the
      // authority for the protected tree before it renders.
      revalidate();
    },
    [navigate, returnTo, revalidate, run],
  );

  return { submit, issues, error, isPending, attemptedEmail, reset };
}
