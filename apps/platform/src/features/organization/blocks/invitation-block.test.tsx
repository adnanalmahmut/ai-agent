import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authClientStub, ok, resetAuthClientStub } from '@/test/auth-client-stub';
import { navigateSpy, resetNavigationStub, revalidateSpy } from '@/test/navigation-stub';
import { renderWithProviders } from '@/test/render';

import type { InvitationDetails } from '../invitation-state';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { InvitationBlock } = await import('./invitation-block');

const INVITATION: InvitationDetails = {
  id: 'inv_1',
  email: 'sara@example.com',
  role: 'admin',
  organizationId: 'org_1',
  organizationName: 'Acme',
  organizationSlug: 'acme',
  inviterEmail: 'owner@example.com',
  expiresAt: '2026-09-01T10:00:00.000Z',
};

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
});

describe('what it shows', () => {
  it('names the organization, the role and who invited you', () => {
    renderWithProviders(<InvitationBlock invitation={INVITATION} />);

    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
    expect(screen.getByText('Administrator')).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
  });

  it('translates the role rather than showing the stored value', () => {
    renderWithProviders(<InvitationBlock invitation={INVITATION} />, {
      locale: 'ar',
    });

    expect(screen.getByText('مسؤول')).toBeInTheDocument();
    expect(screen.queryByText('admin')).not.toBeInTheDocument();
  });

  it('handles the comma-separated role Better Auth stores', () => {
    renderWithProviders(
      <InvitationBlock invitation={{ ...INVITATION, role: 'admin,member' }} />,
    );

    // Joined with Intl.ListFormat, not a hard-coded comma.
    expect(screen.getByText('Administrator and Member')).toBeInTheDocument();
  });

  it('formats the expiry in the reader locale', () => {
    renderWithProviders(<InvitationBlock invitation={INVITATION} />, {
      locale: 'en',
    });

    expect(screen.getByText(/September 1, 2026/)).toBeInTheDocument();
  });
});

describe('accepting', () => {
  it('sends the invitation id', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InvitationBlock invitation={INVITATION} />);

    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    await waitFor(() => {
      expect(
        authClientStub.organization.acceptInvitation,
      ).toHaveBeenCalledWith({ invitationId: 'inv_1' });
    });
  });

  it('goes into the organization it just joined, and revalidates', async () => {
    // Accepting grants a membership *and* makes the organization active, in
    // one server transaction. Neither is visible to loader data already in
    // hand, so the revalidation is not cosmetic. The destination is the
    // organization itself: the reader followed a link about one specific
    // organization, and landing anywhere else makes them go looking for it.
    authClientStub.organization.acceptInvitation.mockResolvedValue(
      ok({ invitation: {}, member: { organizationId: 'org_9' } }),
    );

    const user = userEvent.setup();
    renderWithProviders(<InvitationBlock invitation={INVITATION} />);

    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith('/organizations/org_9', {
        replace: true,
      }),
    );
    expect(revalidateSpy).toHaveBeenCalled();
  });

  it('falls back to the organizations list if no membership comes back', async () => {
    // Defensive rather than expected: the list will contain the new
    // organization either way, so the reader is never stranded.
    authClientStub.organization.acceptInvitation.mockResolvedValue(
      ok({ invitation: {}, member: {} }),
    );

    const user = userEvent.setup();
    renderWithProviders(<InvitationBlock invitation={INVITATION} />);

    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith('/organizations', {
        replace: true,
      }),
    );
  });

  it('disables both buttons while one is running', async () => {
    let release: () => void = () => {};
    authClientStub.organization.acceptInvitation.mockReturnValue(
      new Promise((resolve) => {
        release = () =>
          resolve({ data: { invitation: {}, member: {} }, error: undefined });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<InvitationBlock invitation={INVITATION} />);

    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled(),
    );

    release();
  });
});

describe('declining', () => {
  it('rejects rather than accepting', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InvitationBlock invitation={INVITATION} />);

    await user.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() => {
      expect(
        authClientStub.organization.rejectInvitation,
      ).toHaveBeenCalledWith({ invitationId: 'inv_1' });
    });
    expect(authClientStub.organization.acceptInvitation).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  it('explains an archived organization in its own terms', async () => {
    // Refused by this project's backend hook, not by Better Auth, and the
    // remedy is different: the organization has to be restored first.
    authClientStub.organization.acceptInvitation.mockResolvedValue({
      data: null,
      error: { code: 'ORGANIZATION_ARCHIVED', status: 403 },
    });

    const user = userEvent.setup();
    renderWithProviders(<InvitationBlock invitation={INVITATION} />);

    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(
      await screen.findByText(/archived and cannot be joined/),
    ).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('does not guess between expired, withdrawn and already accepted', async () => {
    // The backend cannot tell them apart on purpose, so the copy names all
    // three rather than asserting one.
    authClientStub.organization.acceptInvitation.mockResolvedValue({
      data: null,
      error: { code: 'INVITATION_NOT_FOUND', status: 400 },
    });

    const user = userEvent.setup();
    renderWithProviders(<InvitationBlock invitation={INVITATION} />);

    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(/expired/);
    expect(alert).toHaveTextContent(/withdrawn/);
    expect(alert).toHaveTextContent(/already been accepted/);
  });

  it('reports a wrong signed-in account with the remedy', async () => {
    authClientStub.organization.acceptInvitation.mockResolvedValue({
      data: null,
      error: {
        code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION',
        status: 403,
      },
    });

    const user = userEvent.setup();
    renderWithProviders(<InvitationBlock invitation={INVITATION} />);

    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(
      await screen.findByText(/sent to a different email address/),
    ).toBeInTheDocument();
  });

  it('reports an unreachable server', async () => {
    authClientStub.organization.acceptInvitation.mockRejectedValue(
      new TypeError('Failed to fetch'),
    );

    const user = userEvent.setup();
    renderWithProviders(<InvitationBlock invitation={INVITATION} />);

    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(
      await screen.findByText(/could not reach the server/i),
    ).toBeInTheDocument();
  });
});
