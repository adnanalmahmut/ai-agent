import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useControlPlaneResource } from './use-control-plane-resource';

/**
 * The hook's race guarantees, tested here rather than through a panel.
 *
 * Every panel disables the row it is writing, so a second write to the same
 * row cannot be issued from the screen — which means these properties are
 * unreachable from a rendered-component test and would go silently untested if
 * they were only asserted there. They still have to hold: the disabled button
 * is UX, not a guarantee, and a panel added later that forgets to lock a row
 * must not be able to leave the screen disagreeing with the server.
 */

type Row = { key: string; value: string };

const row = (key: string, value: string): Row => ({ key, value });

/** A promise whose settlement the test controls. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

/**
 * One stable loader per test, which is the contract the hook states: its fetch
 * effect is keyed on this function, so an inline one would refetch forever.
 */
const loaderFor = (rows: Row[]) => () => Promise.resolve(rows);

/** Renders the hook and waits for the initial load to settle. */
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

    // The second write answers first and lands.
    await act(async () => {
      second.resolve(row('a', 'second'));
      await second.promise;
    });

    expect(result.current.items).toEqual([row('a', 'second')]);

    // The first now answers. It is stale and must not overwrite the second.
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

    // A write is still open on this row; unlocking it here would invite a
    // third write to race the one already in flight.
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
