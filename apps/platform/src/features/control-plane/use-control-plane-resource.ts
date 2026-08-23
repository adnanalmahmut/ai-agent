import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  type ApiErrorDetails,
  ApiUnavailableError,
} from '@/lib/application-api';

/**
 * An array rather than a bare union, so the copy for each kind can be asserted
 * to exist. A union is gone at runtime, and the failure it leaves behind is a
 * raw key path rendered into an error card.
 *
 * `unauthenticated` is separate from `forbidden` because the recoveries are
 * opposites. A session that expired while the tab sat open is fixed by signing
 * in again; being told "you do not have permission to use the control plane"
 * sends an operator looking for a role they already hold, and retrying never
 * helps.
 */
export const CONTROL_PLANE_ERROR_KINDS = [
  'unavailable',
  'unauthenticated',
  'forbidden',
  'invalid',
  'failed',
] as const;

export type ControlPlaneErrorKind = (typeof CONTROL_PLANE_ERROR_KINDS)[number];

/**
 * Load-then-mutate, for the three control-plane resources.
 *
 * All three screens have the same shape — fetch a list, act on one row, show
 * what the server now says — and writing that three times would be three
 * chances to forget the same thing: refusing to apply a superseded response.
 * That matters here more than on an ordinary list. An operator who disables a
 * flag and immediately re-enables it could otherwise leave the screen showing
 * the first answer while the server holds the second, and a control-plane
 * screen that disagrees with the control plane is worse than no screen.
 *
 * The row-level `pendingKey` exists so a table can disable exactly the row
 * being written rather than the whole page: these are independent resources,
 * and blocking all of them because one is in flight would be arbitrary.
 */
export type ControlPlaneResource<T> = {
  items: T[];
  isLoading: boolean;
  /** Whether this row has a write in flight. Per row, not per table. */
  isPending: (key: string) => boolean;
  /**
   * One union for both errors, because the kinds are the same and the
   * messages are keyed off them. `invalid` only ever arises from a write — a
   * listing has nothing to validate — but splitting the type to say so would
   * make one translation lookup into two for no gain.
   */
  loadError: ControlPlaneErrorKind | null;
  actionError: ControlPlaneErrorKind | null;
  /**
   * What the server said was wrong, when it said anything.
   *
   * Kept beside the kind rather than folded into it because the generic
   * sentence cannot be specific enough on its own: "check the allowed range"
   * is meaningless for a credential that did not start with the right prefix,
   * and useless for a bounded integer that does not say what the bound is.
   */
  actionErrorDetails: ApiErrorDetails;
  reload: () => void;
  /**
   * Runs a write, then replaces the row it returns. Errors are captured.
   *
   * Resolves to whether the write succeeded, so a caller can decide what to do
   * with the operator's input — a refused setting value is worth keeping so
   * they can correct it, a refused credential is not worth keeping at all.
   */
  mutate: (key: string, run: () => Promise<T>) => Promise<boolean>;
  dismissActionError: () => void;
};

const detailsOf = (thrown: unknown): ApiErrorDetails =>
  thrown instanceof ApiError ? thrown.details : {};

const classify = (thrown: unknown): ControlPlaneErrorKind => {
  if (thrown instanceof ApiUnavailableError) return 'unavailable';

  if (thrown instanceof ApiError) {
    if (thrown.status === 401) return 'unauthenticated';
    if (thrown.status === 403) return 'forbidden';
    if (thrown.status === 400 || thrown.status === 422) return 'invalid';
  }

  return 'failed';
};

export function useControlPlaneResource<T extends { key: string }>(
  load: (signal: AbortSignal) => Promise<T[]>,
): ControlPlaneResource<T> {
  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  /**
   * A set, not one key.
   *
   * A single scalar makes the rows share a lock they do not share: starting a
   * write on row B would re-enable row A while A's request was still open, and
   * whichever of the two settled first would clear the lock for both. These
   * are independent resources and their writes are independent.
   */
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [loadError, setLoadError] = useState<ControlPlaneErrorKind | null>(
    null,
  );
  const [actionError, setActionError] = useState<ControlPlaneErrorKind | null>(
    null,
  );
  const [actionErrorDetails, setActionErrorDetails] = useState<ApiErrorDetails>(
    {},
  );

  /**
   * Reloading is a token bump rather than a function call.
   *
   * The fetch lives in the effect, so React owns its lifetime: the abort and
   * the "is this response still the current one" question are both answered
   * by the same cleanup, and neither the button nor the first render has to
   * remember to do it. `load` is expected to be `useCallback`-stable, which is
   * what makes this fire once per token rather than once per render.
   */
  const [reloadToken, setReloadToken] = useState(0);

  /** Set by the effect's cleanup, so a write cannot answer into a gone screen. */
  const mountedRef = useRef(true);

  /**
   * One counter per row, so a superseded write cannot win a race.
   *
   * Two writes to the same row can be in flight at once — an operator who
   * disables a flag and immediately clears its override issues both — and
   * nothing guarantees the responses come back in the order they were sent.
   * Applying whichever *lands* last would leave the screen showing a state the
   * server does not hold, which is the one thing a control-plane screen must
   * never do. Only the response whose sequence is still the newest for its row
   * is applied.
   */
  const sequenceRef = useRef(new Map<string, number>());

  useEffect(() => {
    const controller = new AbortController();
    let current = true;

    mountedRef.current = true;

    load(controller.signal)
      .then((loaded) => {
        if (!current) return;

        setItems(loaded);
        setLoadError(null);
        setIsLoading(false);
      })
      .catch((thrown: unknown) => {
        if (!current) return;

        setLoadError(classify(thrown));
        setIsLoading(false);
      });

    return () => {
      current = false;
      mountedRef.current = false;
      controller.abort();
    };
  }, [load, reloadToken]);

  const reload = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    setReloadToken((token) => token + 1);
  }, []);

  const mutate = useCallback(
    async (key: string, run: () => Promise<T>): Promise<boolean> => {
      const sequence = (sequenceRef.current.get(key) ?? 0) + 1;
      sequenceRef.current.set(key, sequence);

      setPendingKeys((keys) => new Set(keys).add(key));
      setActionError(null);
      setActionErrorDetails({});

      const release = () => {
        // Only the newest write for this row owns the lock. An older one
        // finishing must not unlock a row that is still being written.
        if (sequenceRef.current.get(key) !== sequence) return;

        setPendingKeys((keys) => {
          const next = new Set(keys);
          next.delete(key);

          return next;
        });
      };

      try {
        const updated = await run();

        if (!mountedRef.current) return false;
        if (sequenceRef.current.get(key) !== sequence) return false;

        /**
         * The server's row replaces the local one, rather than a local edit
         * followed by a refetch: the response already *is* the resolved state,
         * including the parts the caller did not send — a flag's source, a
         * setting's `isDefault`, a credential's `usable`.
         */
        setItems((rows) => rows.map((row) => (row.key === key ? updated : row)));

        return true;
      } catch (thrown: unknown) {
        if (!mountedRef.current) return false;
        if (sequenceRef.current.get(key) !== sequence) return false;

        setActionError(classify(thrown));
        setActionErrorDetails(detailsOf(thrown));

        return false;
      } finally {
        if (mountedRef.current) release();
      }
    },
    [],
  );

  const dismissActionError = useCallback(() => {
    setActionError(null);
    setActionErrorDetails({});
  }, []);

  const isPending = useCallback(
    (key: string) => pendingKeys.has(key),
    [pendingKeys],
  );

  return {
    items,
    isLoading,
    isPending,
    loadError,
    actionError,
    actionErrorDetails,
    reload,
    mutate,
    dismissActionError,
  };
}
