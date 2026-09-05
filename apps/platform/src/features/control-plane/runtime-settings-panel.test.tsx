import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allowGlobalPermissions,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { renderWithProviders } from '@/test/render';

/**
 * Runtime settings has two states that look alike and must not be confused:
 * the value the server holds, which belongs to the query cache, and the text
 * an operator has typed and not yet saved, which belongs to the row. The
 * tests below pin the boundary between them — in particular that a saved
 * value clears the field while a refused one stays in it — and the ownership
 * guarantees that come with the query rather than with a hook of our own.
 */

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');

  return { authClient: authClientStub };
});

const listRuntimeSettings = vi.fn();
const setRuntimeSetting = vi.fn();
const resetRuntimeSetting = vi.fn();

vi.mock('@/lib/application-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/application-api')>(
    '@/lib/application-api',
  );

  return {
    ...actual,
    listRuntimeSettings: (...args: unknown[]) => listRuntimeSettings(...args),
    setRuntimeSetting: (...args: unknown[]) => setRuntimeSetting(...args),
    resetRuntimeSetting: (...args: unknown[]) => resetRuntimeSetting(...args),
  };
});

const { RuntimeSettingsPanel } = await import('./runtime-settings-panel');
const { ApiError } = await import('@/lib/application-api');

const SETTINGS_KEY = ['control-plane', 'runtime-settings'];

const setting = (overrides: Record<string, unknown> = {}) => ({
  key: 'knowledge.retrieval_max_chunks',
  description: 'How many chunks retrieval may return.',
  value: 12,
  isDefault: true,
  storedValueRejected: false,
  defaultValue: 12,
  sensitivity: 'public',
  editable: true,
  updatedAt: undefined,
  ...overrides,
});

/** The cache the panel is reading from, so a test can look inside it. */
const cache: { client: QueryClient | undefined } = { client: undefined };

const queryData = () => cache.client?.getQueryData(SETTINGS_KEY);

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
      <RuntimeSettingsPanel />
      <CaptureQueryClient />
    </>,
  );

/** A promise the test settles when it chooses to. */
const deferred = <T,>() => {
  let settle!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveWith, rejectWith) => {
    settle = resolveWith;
    reject = rejectWith;
  });

  return { promise, settle, reject };
};

const fieldFor = (key: string) => screen.getByLabelText(key);

beforeEach(() => {
  resetAuthClientStub();
  vi.clearAllMocks();

  listRuntimeSettings.mockResolvedValue([setting()]);
  allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
});

describe('loading runtime settings', () => {
  it('keeps the loaded rows in the query cache rather than in the component', async () => {
    renderPanel();
    await screen.findByText('knowledge.retrieval_max_chunks');

    expect(queryData()).toEqual([setting()]);
  });

  it('re-renders from the cache, which is the only copy of the rows', async () => {
    renderPanel();
    await screen.findByText('knowledge.retrieval_max_chunks');

    // Nothing but the cache changes here. A component holding its own copy of
    // the rows would go on rendering the stale one.
    cache.client?.setQueryData(SETTINGS_KEY, [
      setting({ value: 77, isDefault: false }),
    ]);

    await waitFor(() =>
      expect(fieldFor('knowledge.retrieval_max_chunks')).toHaveValue('77'),
    );
  });

  it('cancels a listing the operator navigated away from', async () => {
    listRuntimeSettings.mockReturnValue(deferred<unknown>().promise);

    const { unmount } = renderPanel();

    await waitFor(() => expect(listRuntimeSettings).toHaveBeenCalled());
    const [signal] = listRuntimeSettings.mock.calls[0] as [AbortSignal];
    expect(signal.aborted).toBe(false);

    unmount();

    expect(signal.aborted).toBe(true);
  });

  it('asks the server again when the operator retries a failed listing', async () => {
    listRuntimeSettings.mockRejectedValueOnce(new ApiError(500, 'INTERNAL'));

    renderPanel();

    await screen.findByText(/something went wrong/i);
    expect(listRuntimeSettings).toHaveBeenCalledTimes(1);

    listRuntimeSettings.mockResolvedValue([setting()]);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await screen.findByText('knowledge.retrieval_max_chunks');
    expect(listRuntimeSettings).toHaveBeenCalledTimes(2);
  });
});

describe('saving a runtime setting', () => {
  it('puts the row the server returned into the cache and empties the draft', async () => {
    const saved = setting({ value: 40, isDefault: false });
    setRuntimeSetting.mockResolvedValue(saved);

    renderPanel();
    await screen.findByText('knowledge.retrieval_max_chunks');

    const field = fieldFor('knowledge.retrieval_max_chunks');
    fireEvent.change(field, { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(queryData()).toEqual([saved]));

    // The field now follows the server again rather than the abandoned text:
    // a later cache write reaches it.
    cache.client?.setQueryData(SETTINGS_KEY, [
      setting({ value: 55, isDefault: false }),
    ]);
    await waitFor(() => expect(field).toHaveValue('55'));
  });

  it('keeps a refused value in the field and leaves the cache untouched', async () => {
    setRuntimeSetting.mockRejectedValue(
      new ApiError(422, 'VALIDATION_ERROR', {
        issues: ['Too big: expected number to be <=100'],
      }),
    );

    renderPanel();
    await screen.findByText('knowledge.retrieval_max_chunks');

    const field = fieldFor('knowledge.retrieval_max_chunks');
    fireEvent.change(field, { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText(/refused/i);
    expect(screen.getByText(/expected number to be <=100/i)).toBeInTheDocument();
    expect(field).toHaveValue('5000');
    expect(queryData()).toEqual([setting()]);
  });

  it('lets the operator dismiss a refusal without losing the correction', async () => {
    setRuntimeSetting.mockRejectedValue(new ApiError(422, 'VALIDATION_ERROR'));

    renderPanel();
    await screen.findByText('knowledge.retrieval_max_chunks');

    const field = fieldFor('knowledge.retrieval_max_chunks');
    fireEvent.change(field, { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText(/refused/i);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() =>
      expect(screen.queryByText(/refused/i)).not.toBeInTheDocument(),
    );
    expect(field).toHaveValue('5000');
  });
});

describe('resetting a runtime setting', () => {
  it('drops an abandoned edit and caches the row the server returned', async () => {
    listRuntimeSettings.mockResolvedValue([
      setting({ value: 40, isDefault: false }),
    ]);
    const restored = setting();
    resetRuntimeSetting.mockResolvedValue(restored);

    renderPanel();
    await screen.findByText('knowledge.retrieval_max_chunks');

    const field = fieldFor('knowledge.retrieval_max_chunks');
    fireEvent.change(field, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));

    await waitFor(() => expect(field).toHaveValue('12'));
    expect(queryData()).toEqual([restored]);
  });

  it('keeps the abandoned edit when the reset itself is refused', async () => {
    const stored = setting({ value: 40, isDefault: false });
    listRuntimeSettings.mockResolvedValue([stored]);
    resetRuntimeSetting.mockRejectedValue(new ApiError(403, 'FORBIDDEN'));

    renderPanel();
    await screen.findByText('knowledge.retrieval_max_chunks');

    const field = fieldFor('knowledge.retrieval_max_chunks');
    fireEvent.change(field, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));

    await screen.findByText(/do not have permission/i);
    expect(field).toHaveValue('99');
    expect(queryData()).toEqual([stored]);
  });
});

describe('writing two settings at once', () => {
  const rows = [
    setting({ key: 'a.one', value: 1, defaultValue: 1 }),
    setting({ key: 'b.two', value: 2, defaultValue: 2 }),
  ];

  it('locks the row being written and leaves the other one usable', async () => {
    listRuntimeSettings.mockResolvedValue(rows);

    const first = deferred<unknown>();
    setRuntimeSetting.mockReturnValueOnce(first.promise);
    setRuntimeSetting.mockResolvedValueOnce(
      setting({ key: 'b.two', value: 9, defaultValue: 2, isDefault: false }),
    );

    renderPanel();
    await screen.findByText('a.one');

    const [saveA, saveB] = screen.getAllByRole('button', { name: /^save$/i });
    const fieldA = fieldFor('a.one');
    const fieldB = fieldFor('b.two');

    fireEvent.change(fieldA, { target: { value: '5' } });
    fireEvent.click(saveA);

    await waitFor(() => expect(saveA).toBeDisabled());
    expect(fieldA).toBeDisabled();
    expect(saveB).toBeEnabled();
    expect(fieldB).toBeEnabled();

    // Not merely enabled: the second row is writable while the first is still
    // in flight.
    fireEvent.change(fieldB, { target: { value: '9' } });
    fireEvent.click(saveB);

    await waitFor(() =>
      expect(setRuntimeSetting).toHaveBeenNthCalledWith(2, 'b.two', 9),
    );

    first.settle(
      setting({ key: 'a.one', value: 5, defaultValue: 1, isDefault: false }),
    );
    await waitFor(() => expect(saveA).toBeEnabled());
  });

  it('lands each response on the row it was written for, whatever the order', async () => {
    listRuntimeSettings.mockResolvedValue(rows);

    const slow = deferred<unknown>();
    setRuntimeSetting.mockReturnValueOnce(slow.promise);
    setRuntimeSetting.mockResolvedValueOnce(
      setting({ key: 'b.two', value: 9, defaultValue: 2, isDefault: false }),
    );

    renderPanel();
    await screen.findByText('a.one');

    const [saveA, saveB] = screen.getAllByRole('button', { name: /^save$/i });

    fireEvent.change(fieldFor('a.one'), { target: { value: '5' } });
    fireEvent.click(saveA);
    await waitFor(() => expect(saveA).toBeDisabled());

    fireEvent.change(fieldFor('b.two'), { target: { value: '9' } });
    fireEvent.click(saveB);

    // The second row answers first; the first row's response arrives after.
    await waitFor(() => expect(saveB).toBeEnabled());

    slow.settle(
      setting({ key: 'a.one', value: 5, defaultValue: 1, isDefault: false }),
    );

    await waitFor(() =>
      expect(queryData()).toEqual([
        setting({ key: 'a.one', value: 5, defaultValue: 1, isDefault: false }),
        setting({ key: 'b.two', value: 9, defaultValue: 2, isDefault: false }),
      ]),
    );
  });

  it('refuses a second write to a row that is already being written', async () => {
    const first = deferred<unknown>();
    setRuntimeSetting.mockReturnValue(first.promise);

    renderPanel();
    await screen.findByText('knowledge.retrieval_max_chunks');

    const save = screen.getByRole('button', { name: /^save$/i });
    fireEvent.click(save);

    await waitFor(() => expect(save).toBeDisabled());

    fireEvent.click(save);
    fireEvent.click(save);

    expect(setRuntimeSetting).toHaveBeenCalledTimes(1);

    first.settle(setting({ value: 12 }));
    await waitFor(() => expect(save).toBeEnabled());
  });
});
