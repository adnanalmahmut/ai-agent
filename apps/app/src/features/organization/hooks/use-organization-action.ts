import { useCallback, useState } from 'react';

import {
  type OrganizationError,
  organizationErrorFrom,
} from '../organization-errors';

type CallResult<T> = { data: T | null; error?: unknown };

export function useOrganizationAction() {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<OrganizationError | null>(null);

  const reset = useCallback(() => setError(null), []);

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
