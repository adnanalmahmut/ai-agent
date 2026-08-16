import { useCallback, useState } from 'react';

import {
  type OrganizationError,
  organizationErrorFrom,
} from '../organization-errors';

/**
 * Anything a Better Auth call can resolve to.
 *
 * It resolves with `{ data, error }` for whatever the server answered, and
 * *rejects* when the request never got there — so both paths have to be
 * handled, and handling them once here is why no hook below contains a
 * try/catch.
 */
type CallResult<T> = { data: T | null; error?: unknown };

/**
 * Pending state and error normalisation for one organization mutation.
 *
 * The organization twin of `useAuthAction`, and separate from it on purpose:
 * the two normalise into different closed unions, so sharing an implementation
 * would mean a generic parameter threaded through every consumer to buy back
 * the type each one had for free.
 *
 * `run` accepts either shape — a Better Auth call or a plain promise from the
 * application API — because the archive endpoint is not a Better Auth call and
 * should not need a different hook to say so.
 */
export function useOrganizationAction() {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<OrganizationError | null>(null);

  const reset = useCallback(() => setError(null), []);

  /** For `{ data, error }` results. Returns `null` when it failed. */
  const run = useCallback(
    async <T>(call: () => Promise<CallResult<T>>): Promise<T | null> => {
      setIsPending(true);
      setError(null);

      try {
        const result = await call();

        if (result.error) {
          setError(organizationErrorFrom({ error: result.error }));
          return null;
        }

        return result.data ?? null;
      } catch (thrown) {
        setError(organizationErrorFrom(thrown));
        return null;
      } finally {
        setIsPending(false);
      }
    },
    [],
  );

  /** For promises that reject instead of resolving with an error half. */
  const runThrowing = useCallback(
    async <T>(call: () => Promise<T>): Promise<T | null> => {
      setIsPending(true);
      setError(null);

      try {
        return await call();
      } catch (thrown) {
        setError(organizationErrorFrom(thrown));
        return null;
      } finally {
        setIsPending(false);
      }
    },
    [],
  );

  return { isPending, error, reset, run, runThrowing };
}
