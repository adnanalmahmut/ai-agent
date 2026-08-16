import { useCallback, useState } from 'react';

import { useAppLocale } from '@/i18n/navigation';

import { authClient } from '../auth-client';
import { passwordResetCallbackUrl } from '../callback-urls';
import {
  type FieldIssues,
  type RequestPasswordResetValues,
  type ResetPasswordValues,
  requestPasswordResetSchema,
  resetPasswordSchema,
  validate,
} from '../validation';
import { useAuthAction } from './use-auth-action';

/**
 * Step one: ask for the email.
 *
 * `isSent` is set for *any* completed request, and that is the point. The
 * backend answers identically whether or not the address exists — it even
 * burns the same work on a miss to keep the timing flat — so surfacing
 * anything more specific here would rebuild the account-existence oracle the
 * backend went to the trouble of denying.
 */
export function useRequestPasswordReset() {
  const locale = useAppLocale();
  const { isPending, error, reset, run } = useAuthAction();
  const [issues, setIssues] = useState<
    FieldIssues<RequestPasswordResetValues>
  >({});
  const [isSent, setIsSent] = useState(false);

  const submit = useCallback(
    async (input: { email: string }) => {
      const parsed = validate(requestPasswordResetSchema, input);

      if (!parsed.ok) {
        setIssues(parsed.issues);
        return;
      }

      setIssues({});

      const result = await run(() =>
        authClient.requestPasswordReset({
          email: parsed.values.email,
          redirectTo: passwordResetCallbackUrl(locale, window.location.origin),
        }),
      );

      if (result) setIsSent(true);
    },
    [locale, run],
  );

  return { submit, issues, error, isPending, isSent, reset };
}

/**
 * Step two: set the new password against the token from the email.
 *
 * The token is read from the query string by the page and passed in; it is
 * never logged, never put in an error message and never sent anywhere except
 * back to the endpoint that issued it.
 */
export function useResetPassword(token: string | null) {
  const { isPending, error, reset, run } = useAuthAction();
  const [issues, setIssues] = useState<FieldIssues<ResetPasswordValues>>({});
  const [isComplete, setIsComplete] = useState(false);

  const submit = useCallback(
    async (input: { password: string; confirmPassword: string }) => {
      const parsed = validate(resetPasswordSchema, input);

      if (!parsed.ok) {
        setIssues(parsed.issues);
        return;
      }

      setIssues({});

      if (!token) return;

      const result = await run(() =>
        authClient.resetPassword({
          newPassword: parsed.values.password,
          token,
        }),
      );

      if (result) setIsComplete(true);
    },
    [run, token],
  );

  return { submit, issues, error, isPending, isComplete, reset };
}
