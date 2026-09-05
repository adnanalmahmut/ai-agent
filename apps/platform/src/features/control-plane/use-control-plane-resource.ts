import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiErrorDetails } from '@/lib/application-api';

import {
  type ControlPlaneErrorKind,
  classifyControlPlaneError,
  controlPlaneErrorDetails,
} from './control-plane-errors';

export type ControlPlaneResource<T> = {
  items: T[];
  isLoading: boolean;
  isPending: (key: string) => boolean;
  loadError: ControlPlaneErrorKind | null;
  actionError: ControlPlaneErrorKind | null;
  actionErrorDetails: ApiErrorDetails;
  reload: () => void;
  mutate: (key: string, run: () => Promise<T>) => Promise<boolean>;
  dismissActionError: () => void;
};

export function useControlPlaneResource<T extends { key: string }>(
  load: (signal: AbortSignal) => Promise<T[]>,
): ControlPlaneResource<T> {
  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(true);
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

  const [reloadToken, setReloadToken] = useState(0);

  const mountedRef = useRef(true);

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

        setLoadError(classifyControlPlaneError(thrown));
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

        setItems((rows) =>
          rows.map((row) => (row.key === key ? updated : row)),
        );

        return true;
      } catch (thrown: unknown) {
        if (!mountedRef.current) return false;
        if (sequenceRef.current.get(key) !== sequence) return false;

        setActionError(classifyControlPlaneError(thrown));
        setActionErrorDetails(controlPlaneErrorDetails(thrown));

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
