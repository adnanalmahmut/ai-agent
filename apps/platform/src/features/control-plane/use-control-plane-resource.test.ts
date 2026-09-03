import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useControlPlaneResource } from './use-control-plane-resource';

type Row = { key: string; value: string };

const row = (key: string, value: string): Row => ({ key, value });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

const loaderFor = (rows: Row[]) => () => Promise.resolve(rows);

const mount = async (rows: Row[]) => {
  const load = loaderFor(rows);
  const { result } = renderHook(() => useControlPlaneResource<Row>(load));

  await waitFor(() => expect(result.current.isLoading).toBe(false));

  return result;
};

describe('useControlPlaneResource', () => {
  it('applies the newest write for a row and discards the one it superseded', async () => {
    const result = await mount([row('a', 'initial')]);

    const first = deferred<Row>();
    const second = deferred<Row>();

    act(() => {
      void result.current.mutate('a', () => first.promise);
      void result.current.mutate('a', () => second.promise);
    });

    await act(async () => {
      second.resolve(row('a', 'second'));
      await second.promise;
    });

    expect(result.current.items).toEqual([row('a', 'second')]);

    await act(async () => {
      first.resolve(row('a', 'first'));
      await first.promise;
    });

    expect(result.current.items).toEqual([row('a', 'second')]);
  });

  it('keeps the row locked when a superseded write finishes before the newest', async () => {
    const result = await mount([row('a', 'initial')]);

    const first = deferred<Row>();
    const second = deferred<Row>();

    act(() => {
      void result.current.mutate('a', () => first.promise);
      void result.current.mutate('a', () => second.promise);
    });

    expect(result.current.isPending('a')).toBe(true);

    await act(async () => {
      first.resolve(row('a', 'first'));
      await first.promise;
    });

    expect(result.current.isPending('a')).toBe(true);

    await act(async () => {
      second.resolve(row('a', 'second'));
      await second.promise;
    });

    expect(result.current.isPending('a')).toBe(false);
  });

  it('locks only the row being written', async () => {
    const result = await mount([row('a', 'a'), row('b', 'b')]);

    const open = deferred<Row>();

    act(() => {
      void result.current.mutate('a', () => open.promise);
    });

    expect(result.current.isPending('a')).toBe(true);
    expect(result.current.isPending('b')).toBe(false);

    await act(async () => {
      open.resolve(row('a', 'written'));
      await open.promise;
    });
  });

  it('reports a refused write without dropping the rows it already had', async () => {
    const result = await mount([row('a', 'initial')]);

    let succeeded: boolean | undefined;

    await act(async () => {
      succeeded = await result.current.mutate('a', () =>
        Promise.reject(new Error('refused')),
      );
    });

    expect(succeeded).toBe(false);
    expect(result.current.actionError).toBe('failed');
    expect(result.current.items).toEqual([row('a', 'initial')]);
    expect(result.current.isPending('a')).toBe(false);
  });
});
