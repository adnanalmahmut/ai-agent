import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allowGlobalPermissions,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { renderWithProviders } from '@/test/render';

/**
 * Feature flags is the first control-plane screen whose server state belongs
 * to TanStack Query rather than to a hook this repository maintains. These
 * tests describe what that ownership has to keep true: the table reads from
 * the query cache and holds no copy of it, an abandoned listing is cancelled,
 * a write locks its own row and no other, and a response can never land on a
 * row it was not written for.
 */

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');

  return { authClient: authClientStub };
});

const listFeatureFlags = vi.fn();
const setFeatureFlag = vi.fn();
const clearFeatureFlag = vi.fn();

vi.mock('@/lib/application-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/application-api')>(
    '@/lib/application-api',
  );

  return {
    ...actual,
    listFeatureFlags: (...args: unknown[]) => listFeatureFlags(...args),
    setFeatureFlag: (...args: unknown[]) => setFeatureFlag(...args),
    clearFeatureFlag: (...args: unknown[]) => clearFeatureFlag(...args),
  };
});

const { FeatureFlagsPanel } = await import('./feature-flags-panel');
const { ApiError } = await import('@/lib/application-api');

const FLAGS_KEY = ['control-plane', 'feature-flags'];

const flag = (overrides: Record<string, unknown> = {}) => ({
  key: 'agents.enabled',
  description: 'Whether agent runs may be accepted.',
  enabled: false,
  source: 'default' as const,
  defaultEnabled: false,
  platformOverride: undefined,
  organizationOverride: undefined,
  organizationOverridable: true,
  ...overrides,
});

/** The cache the panel is reading from, so a test can look inside it. */
const cache: { client: QueryClient | undefined } = { client: undefined };

const queryData = () => cache.client?.getQueryData(FLAGS_KEY);

function CaptureQueryClient() {
  const client = useQueryClient();

  useEffect(() => {
    cache.client = client;
  }, [client]);

  return null;
}

const renderPanel = () =>
  renderWithProviders(
    <>
      <FeatureFlagsPanel />
      <CaptureQueryClient />
    </>,
  );

const rowFor = (flagKey: string) =>
  screen.getByRole('row', { name: new RegExp(flagKey.replace('.', String.raw`\.`)) });

/** A promise the test resolves or rejects when it chooses to. */
const deferred = <T,>() => {
  let settle!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveWith, rejectWith) => {
    settle = resolveWith;
    reject = rejectWith;
  });

  return { promise, settle, reject };
};

beforeEach(() => {
  resetAuthClientStub();
  vi.clearAllMocks();

  listFeatureFlags.mockResolvedValue([flag()]);
  allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
});

describe('loading feature flags', () => {
  it('shows the listing it is waiting for, then the rows it received', async () => {
    const listing = deferred<unknown>();
    listFeatureFlags.mockReturnValue(listing.promise);

    renderPanel();

    expect(screen.getByText(/loading/i)).toBeInTheDocument();

    listing.settle([flag()]);

    await screen.findByText('agents.enabled');
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it('keeps the loaded rows in the query cache rather than in the component', async () => {
    renderPanel();
    await screen.findByText('agents.enabled');

    expect(queryData()).toEqual([flag()]);
  });

  it('re-renders from the cache, which is the only copy of the rows', async () => {
    renderPanel();
    await screen.findByText('agents.enabled');

    // Nothing but the cache changes here. A component holding its own copy of
    // the rows would go on rendering the stale one.
    cache.client?.setQueryData(FLAGS_KEY, [
      flag({ key: 'agents.enabled', enabled: true, source: 'platform' }),
    ]);

    await screen.findByText(/^On$/);
    expect(screen.getByText(/platform override/i)).toBeInTheDocument();
  });

  it('asks once and does not ask again when the window regains focus', async () => {
    renderPanel();
    await screen.findByText('agents.enabled');

    fireEvent.focus(window);
    window.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(listFeatureFlags).toHaveBeenCalledTimes(1));
  });

  it('cancels a listing the operator navigated away from', async () => {
    listFeatureFlags.mockReturnValue(deferred<unknown>().promise);

    const { unmount } = renderPanel();

    await waitFor(() => expect(listFeatureFlags).toHaveBeenCalled());
    const [signal] = listFeatureFlags.mock.calls[0] as [AbortSignal];
    expect(signal.aborted).toBe(false);

    unmount();

    expect(signal.aborted).toBe(true);
  });
});

describe('a listing that failed', () => {
  it('classifies the failure, retries on request, and does not retry on its own', async () => {
    listFeatureFlags.mockRejectedValueOnce(new ApiError(500, 'INTERNAL'));

    renderPanel();

    await screen.findByText(/something went wrong/i);
    expect(listFeatureFlags).toHaveBeenCalledTimes(1);

    listFeatureFlags.mockResolvedValue([flag()]);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await screen.findByText('agents.enabled');
    expect(listFeatureFlags).toHaveBeenCalledTimes(2);
  });

  it('tells a refused reader apart from an unreachable API', async () => {
    listFeatureFlags.mockRejectedValue(new ApiError(403, 'FORBIDDEN'));

    renderPanel();

    await screen.findByText(/do not have permission/i);
    expect(screen.queryByText(/could not be reached/i)).not.toBeInTheDocument();
  });
});

describe('writing a feature flag', () => {
  it('replaces the written row in the cache with what the server returned', async () => {
    const updated = flag({
      enabled: true,
      source: 'platform',
      platformOverride: true,
    });
    setFeatureFlag.mockResolvedValue(updated);

    renderPanel();
    await screen.findByText('agents.enabled');

    fireEvent.click(screen.getByRole('button', { name: /enable/i }));

    await screen.findByText(/^On$/);
    expect(setFeatureFlag).toHaveBeenCalledWith('agents.enabled', true);
    expect(queryData()).toEqual([updated]);
  });

  it('locks the row being written and leaves the other rows usable', async () => {
    listFeatureFlags.mockResolvedValue([
      flag({ key: 'a.one' }),
      flag({ key: 'b.two' }),
    ]);

    const first = deferred<unknown>();
    setFeatureFlag.mockReturnValueOnce(first.promise);
    setFeatureFlag.mockResolvedValueOnce(flag({ key: 'b.two', enabled: true }));

    renderPanel();
    await screen.findByText('a.one');

    const [enableA, enableB] = screen.getAllByRole('button', {
      name: /enable/i,
    });
    const [, clearA] = screen.getAllByRole('button', {
      name: /clear override/i,
    });

    fireEvent.click(enableA);

    await waitFor(() => expect(enableA).toBeDisabled());
    expect(clearA).toBeDisabled();
    expect(enableB).toBeEnabled();

    // The spinner belongs to the row being written and to no other.
    expect(rowFor('a.one').querySelector('.animate-spin')).not.toBeNull();
    expect(rowFor('b.two').querySelector('.animate-spin')).toBeNull();

    // The second row is not merely enabled, it is writable while the first
    // row is still in flight.
    fireEvent.click(enableB);

    await waitFor(() =>
      expect(setFeatureFlag).toHaveBeenNthCalledWith(2, 'b.two', true),
    );

    first.settle(flag({ key: 'a.one', enabled: true }));
    await waitFor(() => expect(enableA).toBeEnabled());
  });

  it('refuses a second write to a row that is already being written', async () => {
    const first = deferred<unknown>();
    setFeatureFlag.mockReturnValue(first.promise);

    renderPanel();
    await screen.findByText('agents.enabled');

    const enable = screen.getByRole('button', { name: /enable/i });
    fireEvent.click(enable);

    await waitFor(() => expect(enable).toBeDisabled());

    fireEvent.click(enable);
    fireEvent.click(enable);

    expect(setFeatureFlag).toHaveBeenCalledTimes(1);

    first.settle(flag({ enabled: true }));
    await screen.findByText(/^On$/);
  });

  it('lands each response on the row it was written for, whatever the order', async () => {
    listFeatureFlags.mockResolvedValue([
      flag({ key: 'a.one' }),
      flag({ key: 'b.two' }),
    ]);

    const slow = deferred<unknown>();
    setFeatureFlag.mockReturnValueOnce(slow.promise);
    setFeatureFlag.mockResolvedValueOnce(
      flag({ key: 'b.two', enabled: true, source: 'platform' }),
    );

    renderPanel();
    await screen.findByText('a.one');

    const [enableA, enableB] = screen.getAllByRole('button', {
      name: /enable/i,
    });

    fireEvent.click(enableA);
    await waitFor(() => expect(enableA).toBeDisabled());
    fireEvent.click(enableB);

    // The second row answers first; the first row's response arrives after.
    await waitFor(() => expect(enableB).toBeEnabled());

    slow.settle(flag({ key: 'a.one', enabled: true, source: 'platform' }));

    await waitFor(() =>
      expect(queryData()).toEqual([
        flag({ key: 'a.one', enabled: true, source: 'platform' }),
        flag({ key: 'b.two', enabled: true, source: 'platform' }),
      ]),
    );
  });
});

describe('a write that failed', () => {
  it('reports the refusal with its reasons, dismisses it, and keeps the table', async () => {
    setFeatureFlag.mockRejectedValue(
      new ApiError(422, 'VALIDATION_ERROR', {
        kind: 'validation',
        fields: [],
        messages: ['agents.enabled cannot be overridden here'],
      }),
    );

    renderPanel();
    await screen.findByText('agents.enabled');

    fireEvent.click(screen.getByRole('button', { name: /enable/i }));

    await screen.findByText(/refused/i);
    expect(
      screen.getByText(/cannot be overridden here/i),
    ).toBeInTheDocument();

    // The listing is untouched: a rejected write caches nothing.
    expect(queryData()).toEqual([flag()]);
    expect(screen.getByText('agents.enabled')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() =>
      expect(screen.queryByText(/refused/i)).not.toBeInTheDocument(),
    );
  });

  it('releases the row it locked so the operator can try again', async () => {
    setFeatureFlag.mockRejectedValueOnce(new ApiError(500, 'INTERNAL'));

    renderPanel();
    await screen.findByText('agents.enabled');

    const enable = screen.getByRole('button', { name: /enable/i });
    fireEvent.click(enable);

    await screen.findByText(/something went wrong/i);
    expect(enable).toBeEnabled();
  });

  it('clears the previous failure when the next write starts', async () => {
    setFeatureFlag.mockRejectedValueOnce(new ApiError(500, 'INTERNAL'));

    renderPanel();
    await screen.findByText('agents.enabled');

    fireEvent.click(screen.getByRole('button', { name: /enable/i }));
    await screen.findByText(/something went wrong/i);

    const pending = deferred<unknown>();
    setFeatureFlag.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: /enable/i }));

    await waitFor(() =>
      expect(
        screen.queryByText(/something went wrong/i),
      ).not.toBeInTheDocument(),
    );

    pending.settle(flag({ enabled: true }));
    await screen.findByText(/^On$/);
  });
});
