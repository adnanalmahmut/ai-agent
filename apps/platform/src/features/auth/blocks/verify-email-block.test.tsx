import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authClientStub, resetAuthClientStub } from '@/test/auth-client-stub';
import { resetNavigationStub } from '@/test/navigation-stub';
import { renderWithProviders } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { VerifyEmailBlock } = await import('./verify-email-block');

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
});

describe('arriving from the emailed link', () => {
  it('confirms success', async () => {
    renderWithProviders(<VerifyEmailBlock isVerified />);

    expect(await screen.findByText('Email confirmed')).toBeInTheDocument();
  });

  it('says plainly that confirming does not sign you in', async () => {
    renderWithProviders(<VerifyEmailBlock isVerified />);

    expect(await screen.findByText(/does not sign you in/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
      'href',
      '/en/sign-in',
    );
  });

  it('explains an expired link and keeps the resend form', async () => {
    renderWithProviders(
      <VerifyEmailBlock isVerified callbackError="TOKEN_EXPIRED" />,
    );

    expect(
      await screen.findByText('This link has expired.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });

  it('does not claim success when the token was rejected', async () => {
    renderWithProviders(
      <VerifyEmailBlock isVerified callbackError="INVALID_TOKEN" />,
    );

    expect(screen.queryByText('Email confirmed')).not.toBeInTheDocument();
    expect(
      await screen.findByText('That link did not work'),
    ).toBeInTheDocument();
  });

  it('recognises an address that is already confirmed', async () => {
    renderWithProviders(
      <VerifyEmailBlock
        isVerified={false}
        callbackError="EMAIL_ALREADY_VERIFIED"
      />,
    );

    expect(
      await screen.findByText('That email address is already confirmed.'),
    ).toBeInTheDocument();
  });
});

describe('asking for a new link', () => {
  it('sends one with a callback that returns here', async () => {
    const user = userEvent.setup();
    renderWithProviders(<VerifyEmailBlock isVerified={false} />, {
      locale: 'en',
    });

    await user.type(screen.getByLabelText('Email address'), 'sara@example.com');
    await user.click(
      screen.getByRole('button', { name: 'Send the link again' }),
    );

    await waitFor(() => {
      expect(authClientStub.sendVerificationEmail).toHaveBeenCalledWith({
        email: 'sara@example.com',
        callbackURL:
          'http://localhost:3000/platform/en/verify-email?status=verified',
      });
    });
  });

  it('replaces the form with a neutral confirmation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<VerifyEmailBlock isVerified={false} />);

    await user.type(screen.getByLabelText('Email address'), 'sara@example.com');
    await user.click(
      screen.getByRole('button', { name: 'Send the link again' }),
    );

    expect(
      await screen.findByText(/a new link is on its way/),
    ).toBeInTheDocument();
  });

  it('validates the address first', async () => {
    const user = userEvent.setup();
    renderWithProviders(<VerifyEmailBlock isVerified={false} />);

    await user.type(screen.getByLabelText('Email address'), 'nope');
    await user.click(
      screen.getByRole('button', { name: 'Send the link again' }),
    );

    expect(
      await screen.findByText('That does not look like an email address.'),
    ).toBeInTheDocument();
    expect(authClientStub.sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe('localisation', () => {
  it('renders Arabic copy', () => {
    renderWithProviders(<VerifyEmailBlock isVerified />, { locale: 'ar' });

    expect(screen.getByText('تم تأكيد البريد الإلكتروني')).toBeInTheDocument();
  });
});
