import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authClientStub,
  fail,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { navigateSpy, resetNavigationStub } from '@/test/navigation-stub';
import { renderWithProviders } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { SignUpBlock } = await import('./sign-up-block');

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
});

async function register() {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText('Full name'), 'Sara Haddad');
  await user.type(screen.getByLabelText('Email address'), 'sara@example.com');
  await user.type(screen.getByLabelText('Password'), 'a-good-password');
  await user.click(screen.getByRole('button', { name: 'Create account' }));

  return user;
}

describe('registering', () => {
  it('sends the details and a callback that comes back to this app', async () => {
    renderWithProviders(<SignUpBlock />, { locale: 'en' });

    await register();

    await waitFor(() => {
      expect(authClientStub.signUp.email).toHaveBeenCalledWith({
        name: 'Sara Haddad',
        email: 'sara@example.com',
        password: 'a-good-password',
        // Without this, Better Auth points the emailed link at the API host.
        callbackURL:
          'http://localhost:3000/platform/en/verify-email?status=verified',
      });
    });
  });

  it('does not pretend the user is signed in', async () => {
    // The backend requires email verification, so registration creates a user
    // and no session. Navigating to the dashboard would land on a redirect.
    renderWithProviders(<SignUpBlock />);

    await register();

    await waitFor(() =>
      expect(screen.getByText(/Confirm your email/)).toBeInTheDocument(),
    );
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('shows the address the link was sent to', async () => {
    renderWithProviders(<SignUpBlock />);

    await register();

    expect(await screen.findByText('sara@example.com')).toBeInTheDocument();
  });

  it('can resend from the pending state without retyping', async () => {
    renderWithProviders(<SignUpBlock />);
    const user = await register();

    await user.click(
      await screen.findByRole('button', { name: 'Send the link again' }),
    );

    await waitFor(() => {
      expect(authClientStub.sendVerificationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'sara@example.com' }),
      );
    });
  });
});

describe('failures', () => {
  it('reports an address that is already registered', async () => {
    authClientStub.signUp.email.mockResolvedValue(
      fail('USER_ALREADY_EXISTS', 422),
    );

    renderWithProviders(<SignUpBlock />);
    await register();

    expect(
      await screen.findByText(
        'There is already an account for that email address.',
      ),
    ).toBeInTheDocument();
  });

  it('validates before calling the server', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SignUpBlock />);

    await user.type(screen.getByLabelText('Email address'), 'sara@example.com');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
    expect(
      screen.getByText('Passwords need at least 8 characters.'),
    ).toBeInTheDocument();
    expect(authClientStub.signUp.email).not.toHaveBeenCalled();
  });
});

describe('localisation', () => {
  it('renders Arabic copy', () => {
    renderWithProviders(<SignUpBlock />, { locale: 'ar' });

    expect(screen.getByText('أنشئ حسابك')).toBeInTheDocument();
    expect(screen.getByLabelText('الاسم الكامل')).toBeInTheDocument();
  });
});
