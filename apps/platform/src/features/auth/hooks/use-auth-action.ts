import { useCallback, useState } from 'react';

import { type AuthErrorCode, normalizeAuthError } from '../auth-errors';

type AuthCallResult<T> = { data: T | null; error?: unknown };

export type AuthAction = {
  readonly isPending: boolean;
  readonly error: AuthErrorCode | null;
  readonly reset: () => void;
  readonly fail: (code: AuthErrorCode) => void;
};

export function useAuthAction(): AuthAction & {
  run: <T>(call: () => Promise<AuthCallResult<T>>) => Promise<T | null>;
} {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<AuthErrorCode | null>(null);

  const reset = useCallback(() => setError(null), []);
  const fail = useCallback((code: AuthErrorCode) => setError(code), []);

  const run = useCallback(
    async <T>(call: () => Promise<AuthCallResult<T>>): Promise<T | null> => {
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
