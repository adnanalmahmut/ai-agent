import { useCallback, useState } from 'react';

import { type AuthErrorCode, normalizeAuthError } from '../auth-errors';

/**
 * The shape every Better Auth client call resolves to.
 *
 * It resolves with `{ data, error }` for anything the server answered, and
 * *rejects* when the request never got there — so both paths have to be
 * handled, and handling them once here is the reason no hook below contains a
 * try/catch.
 */
type AuthCallResult<T> = { data: T | null; error?: unknown };

export type AuthAction = {
  readonly isPending: boolean;
  readonly error: AuthErrorCode | null;
  /** Clears the banner when the user starts editing again. */
  readonly reset: () => void;
  readonly fail: (code: AuthErrorCode) => void;
};

/**
 * Pending state and error normalisation for one asynchronous auth call.
 *
 * Extracted because every flow needs exactly this and nothing more: a spinner
 * while it runs, a normalised code if it fails, and a cleared banner when the
 * user tries again. Duplicating it per hook is how one of them ends up
 * rendering a raw provider message.
 */
export function useAuthAction(): AuthAction & {
  run: <T>(call: () => Promise<AuthCallResult<T>>) => Promise<T | null>;
} {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<AuthErrorCode | null>(null);

  const reset = useCallback(() => setError(null), []);
  const fail = useCallback((code: AuthErrorCode) => setError(code), []);

  const run = useCallback(
    async <T,>(call: () => Promise<AuthCallResult<T>>): Promise<T | null> => {
      setIsPending(true);
      setError(null);

      try {
        const result = await call();

        if (result.error) {
          setError(normalizeAuthError(result.error));
          return null;
        }

        return result.data ?? null;
      } catch (thrown) {
        setError(normalizeAuthError(thrown));
        return null;
      } finally {
        setIsPending(false);
      }
    },
    [],
  );

  return { isPending, error, reset, fail, run };
}
