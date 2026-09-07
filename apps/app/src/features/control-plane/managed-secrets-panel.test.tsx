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
 * Managed secrets is the one control-plane screen where the local draft holds
 * something dangerous. Its rules are deliberately the opposite of runtime
 * settings': a value the server refused is still a credential, so it leaves
 * the screen either way, while a note the screen itself refused was never
 * sent and stays put to be corrected.
 *
 * The tests below pin those two rules, and pin that the credential reaches
 * neither the query cache nor the document — the server answers with a
 * description of the slot, never with what is in it.
 */

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');

  return { authClient: authClientStub };
});

const listManagedSecrets = vi.fn();
const setManagedSecret = vi.fn();
const removeManagedSecret = vi.fn();

vi.mock('@/lib/application-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/application-api')>(
    '@/lib/application-api',
  );

  return {
    ...actual,
    listManagedSecrets: (...args: unknown[]) => listManagedSecrets(...args),
    setManagedSecret: (...args: unknown[]) => setManagedSecret(...args),
    removeManagedSecret: (...args: unknown[]) => removeManagedSecret(...args),
  };
});

const { ManagedSecretsPanel } = await import('./managed-secrets-panel');
const { ApiError } = await import('@/lib/application-api');

const SECRETS_KEY = ['control-plane', 'managed-secrets'];

/** Never a real credential shape, but distinctive enough to find anywhere. */
const CANARY = 'sk-fake-CANARY-0000-not-a-real-key';

const secret = (overrides: Record<string, unknown> = {}) => ({
  key: 'openai.api_key',
  description: 'OpenAI API key.',
  configured: false,
  label: undefined,
  algorithm: undefined,
  keyVersion: undefined,
  lastRotatedAt: undefined,
  updatedAt: undefined,
  usable: false,
  ...overrides,
});

/** The cache the panel is reading from, so a test can look inside it. */
const cache: { client: QueryClient | undefined } = { client: undefined };

const queryData = () => cache.client?.getQueryData(SECRETS_KEY);

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
      <ManagedSecretsPanel />
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

const valueField = (key = 'openai.api_key') =>
  screen.getByLabelText(new RegExp(`new value for ${key.split('.')[0]}`, 'i'));

const labelField = (key = 'openai.api_key') =>
  screen.getByLabelText(new RegExp(`label for ${key.split('.')[0]}`, 'i'));

beforeEach(() => {
  resetAuthClientStub();
  vi.clearAllMocks();

  listManagedSecrets.mockResolvedValue([secret()]);
  allowGlobalPermissions('controlPlane:read', 'managedSecret:write');
});

describe('loading managed secrets', () => {
  it('keeps the loaded rows in the query cache rather than in the component', async () => {
    renderPanel();
    await screen.findByText('openai.api_key');

    expect(queryData()).toEqual([secret()]);
  });

  it('re-renders from the cache, which is the only copy of the rows', async () => {
    renderPanel();
    await screen.findByText('openai.api_key');

    // Nothing but the cache changes here. A component holding its own copy of
    // the rows would go on rendering the stale one.
    cache.client?.setQueryData(SECRETS_KEY, [
      secret({ configured: true, usable: true, label: 'billing account' }),
    ]);

    await screen.findByText(/billing account/i);
    expect(screen.getByText(/^Configured$/)).toBeInTheDocument();
  });

  it('cancels a listing the operator navigated away from', async () => {
    listManagedSecrets.mockReturnValue(deferred<unknown>().promise);

    const { unmount } = renderPanel();

    await waitFor(() => expect(listManagedSecrets).toHaveBeenCalled());
    const [signal] = listManagedSecrets.mock.calls[0] as [AbortSignal];
    expect(signal.aborted).toBe(false);

    unmount();

    expect(signal.aborted).toBe(true);
  });
});

describe('storing a credential', () => {
  it('caches the description the server returned and empties both fields', async () => {
    const stored = secret({
      configured: true,
      usable: true,
      label: 'billing account',
      lastRotatedAt: '2026-02-02T09:30:00.000Z',
    });
    setManagedSecret.mockResolvedValue(stored);

    renderPanel();
    await screen.findByText('openai.api_key');

    fireEvent.change(valueField(), { target: { value: CANARY } });
    fireEvent.change(labelField(), { target: { value: 'billing account' } });
    fireEvent.click(screen.getByRole('button', { name: /^store$/i }));

    await waitFor(() => expect(queryData()).toEqual([stored]));

    expect(valueField()).toHaveValue('');
    expect(labelField()).toHaveValue('');
  });

  it('empties both fields even when the server refused the credential', async () => {
    setManagedSecret.mockRejectedValue(
      new ApiError(422, 'VALIDATION_ERROR', {
        kind: 'validation',
        fields: [],
        messages: ['The value does not start with "sk-".'],
      }),
    );

    renderPanel();
    await screen.findByText('openai.api_key');

    fireEvent.change(valueField(), { target: { value: CANARY } });
    fireEvent.change(labelField(), { target: { value: 'billing account' } });
    fireEvent.click(screen.getByRole('button', { name: /^store$/i }));

    await screen.findByText(/refused/i);
    expect(screen.getByText(/does not start with/i)).toBeInTheDocument();

    // The refusal changed nothing on the server, but the value is still a
    // credential and does not stay on the screen.
    expect(valueField()).toHaveValue('');
    expect(labelField()).toHaveValue('');
    expect(queryData()).toEqual([secret()]);
  });

  it('never lets the submitted credential reach the cache or the document', async () => {
    setManagedSecret.mockResolvedValue(
      secret({ configured: true, usable: true }),
    );

    const { container } = renderPanel();
    await screen.findByText('openai.api_key');

    fireEvent.change(valueField(), { target: { value: CANARY } });
    fireEvent.click(screen.getByRole('button', { name: /^store$/i }));

    await waitFor(() => expect(valueField()).toHaveValue(''));

    expect(JSON.stringify(queryData())).not.toContain(CANARY);
    expect(container.innerHTML).not.toContain(CANARY);
    expect(document.body.innerHTML).not.toContain(CANARY);
  });

  it('refuses a note holding the credential without sending or clearing it', async () => {
    renderPanel();
    await screen.findByText('openai.api_key');

    fireEvent.change(valueField(), { target: { value: CANARY } });
    fireEvent.change(labelField(), {
      target: { value: `pasted here first: ${CANARY}` },
    });
    fireEvent.click(screen.getByRole('button', { name: /^store$/i }));

    await screen.findByText(/note contains the credential/i);
    expect(setManagedSecret).not.toHaveBeenCalled();

    // Nothing was sent, so the operator still has a note to fix rather than a
    // credential to retype.
    expect(valueField()).toHaveValue(CANARY);
    expect(labelField()).toHaveValue(`pasted here first: ${CANARY}`);
  });

  it('sends an omitted note as undefined rather than an empty string', async () => {
    setManagedSecret.mockResolvedValue(secret({ configured: true }));

    renderPanel();
    await screen.findByText('openai.api_key');

    fireEvent.change(valueField(), { target: { value: CANARY } });
    fireEvent.change(labelField(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /^store$/i }));

    await waitFor(() =>
      expect(setManagedSecret).toHaveBeenCalledWith(
        'openai.api_key',
        CANARY,
        undefined,
      ),
    );
  });
});

describe('removing a credential', () => {
  it('replaces only the row the server answered for', async () => {
    listManagedSecrets.mockResolvedValue([
      secret({ key: 'openai.api_key', configured: true, usable: true }),
      secret({ key: 'anthropic.api_key', configured: true, usable: true }),
    ]);
    const emptied = secret({ key: 'openai.api_key' });
    removeManagedSecret.mockResolvedValue(emptied);

    renderPanel();
    await screen.findByText('openai.api_key');

    const [removeFirst] = screen.getAllByRole('button', { name: /remove/i });
    fireEvent.click(removeFirst);

    await waitFor(() =>
      expect(queryData()).toEqual([
        emptied,
        secret({ key: 'anthropic.api_key', configured: true, usable: true }),
      ]),
    );
  });

  it('leaves the cached row intact when the removal is refused', async () => {
    const configured = secret({ configured: true, usable: true });
    listManagedSecrets.mockResolvedValue([configured]);
    removeManagedSecret.mockRejectedValue(new ApiError(403, 'FORBIDDEN'));

    renderPanel();
    await screen.findByText('openai.api_key');

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));

    await screen.findByText(/do not have permission/i);
    expect(queryData()).toEqual([configured]);
    expect(screen.getByText(/^Configured$/)).toBeInTheDocument();
  });

  it('lets the operator dismiss a refusal', async () => {
    listManagedSecrets.mockResolvedValue([
      secret({ configured: true, usable: true }),
    ]);
    removeManagedSecret.mockRejectedValue(new ApiError(403, 'FORBIDDEN'));

    renderPanel();
    await screen.findByText('openai.api_key');

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await screen.findByText(/do not have permission/i);

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() =>
      expect(
        screen.queryByText(/do not have permission/i),
      ).not.toBeInTheDocument(),
    );
  });
});

describe('writing two credentials at once', () => {
  const rows = [
    secret({ key: 'openai.api_key' }),
    secret({ key: 'anthropic.api_key' }),
  ];

  it('locks the row being written and leaves the other one usable', async () => {
    listManagedSecrets.mockResolvedValue(rows);

    const first = deferred<unknown>();
    setManagedSecret.mockReturnValueOnce(first.promise);
    setManagedSecret.mockResolvedValueOnce(
      secret({ key: 'anthropic.api_key', configured: true }),
    );

    renderPanel();
    await screen.findByText('openai.api_key');

    const [storeA, storeB] = screen.getAllByRole('button', {
      name: /^store$/i,
    });

    fireEvent.change(valueField('openai.api_key'), {
      target: { value: CANARY },
    });
    fireEvent.click(storeA);

    await waitFor(() => expect(storeA).toBeDisabled());
    expect(valueField('openai.api_key')).toBeDisabled();
    expect(valueField('anthropic.api_key')).toBeEnabled();

    // Not merely enabled: the second row is writable while the first is still
    // in flight.
    fireEvent.change(valueField('anthropic.api_key'), {
      target: { value: `${CANARY}-other` },
    });
    fireEvent.click(storeB);

    await waitFor(() =>
      expect(setManagedSecret).toHaveBeenNthCalledWith(
        2,
        'anthropic.api_key',
        `${CANARY}-other`,
        undefined,
      ),
    );

    // The row unlocks; Store stays disabled only because the write cleared
    // the credential field, which is the point of clearing it.
    first.settle(secret({ key: 'openai.api_key', configured: true }));
    await waitFor(() =>
      expect(valueField('openai.api_key')).toBeEnabled(),
    );
    expect(valueField('openai.api_key')).toHaveValue('');
  });

  it('refuses a second write to a row that is already being written', async () => {
    const first = deferred<unknown>();
    setManagedSecret.mockReturnValue(first.promise);

    renderPanel();
    await screen.findByText('openai.api_key');

    fireEvent.change(valueField(), { target: { value: CANARY } });
    const store = screen.getByRole('button', { name: /^store$/i });
    fireEvent.click(store);

    await waitFor(() => expect(store).toBeDisabled());

    fireEvent.click(store);
    fireEvent.click(store);

    expect(setManagedSecret).toHaveBeenCalledTimes(1);

    first.settle(secret({ configured: true }));
    await waitFor(() => expect(valueField()).toBeEnabled());
    expect(valueField()).toHaveValue('');
  });
});
