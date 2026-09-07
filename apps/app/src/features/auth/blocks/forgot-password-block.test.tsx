import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authClientStub,
  fail,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { resetNavigationStub } from '@/test/navigation-stub';
import { renderWithProviders } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { ForgotPasswordBlock } = await import('./forgot-password-block');

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
});

async function request(email = 'sara@example.com') {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText('Email address'), email);
  await user.click(screen.getByRole('button', { name: 'Send reset link' }));

  return user;
}

describe('requesting a reset link', () => {
  it('asks Better Auth to send one, pointing back at this app', async () => {
    renderWithProviders(<ForgotPasswordBlock />, { locale: 'en' });

    await request();

    await waitFor(() => {
      expect(authClientStub.requestPasswordReset).toHaveBeenCalledWith({
        email: 'sara@example.com',
        redirectTo: 'http://localhost:3000/platform/en/reset-password',
      });
    });
  });

  it('confirms without saying whether the account exists', async () => {
    renderWithProviders(<ForgotPasswordBlock />);

    await request();

    expect(
      await screen.findByText(
        'If an account exists for that address, a reset link is on its way.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the same screen for an address that cannot exist', async () => {
    renderWithProviders(<ForgotPasswordBlock />);

    await request('nobody@example.com');

    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('validates the address before sending', async () => {
    renderWithProviders(<ForgotPasswordBlock />);

    await request('not-an-email');

    expect(
      await screen.findByText('That does not look like an email address.'),
    ).toBeInTheDocument();
    expect(authClientStub.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('surfaces rate limiting rather than a false confirmation', async () => {
    authClientStub.requestPasswordReset.mockResolvedValue(
      fail('TOO_MANY_REQUESTS', 429),
    );

    renderWithProviders(<ForgotPasswordBlock />);
    await request();

    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument();
    expect(screen.queryByText('Check your inbox')).not.toBeInTheDocument();
  });
});

describe('localisation', () => {
  it('renders Arabic copy', () => {
    renderWithProviders(<ForgotPasswordBlock />, { locale: 'ar' });

    expect(screen.getByText('إعادة تعيين كلمة المرور')).toBeInTheDocument();
  });
});
