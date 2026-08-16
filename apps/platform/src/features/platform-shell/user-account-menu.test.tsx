import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authClientStub, fail, resetAuthClientStub } from '@/test/auth-client-stub';
import { navigateSpy, resetNavigationStub, revalidateSpy } from '@/test/navigation-stub';
import { renderWithProviders } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { UserAccountMenu } = await import('./user-account-menu');

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
  authClientStub.useSession.mockReturnValue({
    data: { user: { role: 'user' }, session: {} },
    isPending: false,
  } as never);
});

const open = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Open the account menu' }));
  return user;
};

function Menu() {
  return (
    <UserAccountMenu name="Sara Haddad" email="sara@example.com" image={null} />
  );
}

describe('identity', () => {
  it('falls back to initials when there is no picture', () => {
    renderWithProviders(<Menu />);

    expect(screen.getByText('SH')).toBeInTheDocument();
  });

  it('shows the name and address once opened', async () => {
    renderWithProviders(<Menu />);
    await open();

    expect(await screen.findByText('Sara Haddad')).toBeInTheDocument();
    expect(screen.getByText('sara@example.com')).toBeInTheDocument();
  });

  it('names the trigger for screen readers', () => {
    renderWithProviders(<Menu />);

    expect(
      screen.getByRole('button', { name: 'Open the account menu' }),
    ).toBeInTheDocument();
  });
});

describe('administration entry', () => {
  it('is hidden without the permission', async () => {
    authClientStub.admin.checkRolePermission.mockReturnValue(false);

    renderWithProviders(<Menu />);
    await open();

    expect(
      screen.queryByRole('menuitem', { name: 'Administration' }),
    ).not.toBeInTheDocument();
  });

  it('appears with it', async () => {
    authClientStub.admin.checkRolePermission.mockReturnValue(true);

    renderWithProviders(<Menu />);
    await open();

    expect(
      await screen.findByRole('menuitem', { name: 'Administration' }),
    ).toBeInTheDocument();
  });
});

describe('signing out', () => {
  it('asks the server to end the session', async () => {
    // The cookie is deleted by the server. Clearing it here would leave the
    // session row alive, which is the opposite of signing out.
    renderWithProviders(<Menu />);
    const user = await open();

    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(authClientStub.signOut).toHaveBeenCalled());
  });

  it('leaves the private tree and discards its cached payloads', async () => {
    renderWithProviders(<Menu />);
    const user = await open();

    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith('/sign-in', { replace: true }),
    );
    expect(revalidateSpy).toHaveBeenCalled();
  });

  it('stays put when the server refuses', async () => {
    // Navigating anyway would bounce the user straight back in — the cookie
    // is still valid — and present as a page that flickered.
    authClientStub.signOut.mockResolvedValue(fail('UNKNOWN', 500));

    renderWithProviders(<Menu />);
    const user = await open();

    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(authClientStub.signOut).toHaveBeenCalled());
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

describe('localisation', () => {
  it('labels the menu in Arabic', () => {
    renderWithProviders(<Menu />, { locale: 'ar' });

    expect(
      screen.getByRole('button', { name: 'فتح قائمة الحساب' }),
    ).toBeInTheDocument();
  });
});
