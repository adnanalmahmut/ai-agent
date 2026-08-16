import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authClientStub,
  fail,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { renderWithProviders } from '@/test/render';
import { navigateSpy, resetNavigationStub, revalidateSpy } from '@/test/navigation-stub';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { SignInBlock } = await import('./sign-in-block');

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
});

async function fillAndSubmit(
  email = 'sara@example.com',
  password = 'a-good-password',
) {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText('Email address'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  return user;
}

describe('signing in', () => {
  it('sends the credentials to Better Auth', async () => {
    renderWithProviders(<SignInBlock />);

    await fillAndSubmit();

    await waitFor(() => {
      expect(authClientStub.signIn.email).toHaveBeenCalledWith({
        email: 'sara@example.com',
        password: 'a-good-password',
      });
    });
  });

  it('lands on the dashboard when no destination was interrupted', async () => {
    renderWithProviders(<SignInBlock />);

    await fillAndSubmit();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('returns to the interrupted destination, query string and all', async () => {
    renderWithProviders(<SignInBlock returnTo="/reports?filter=x" />);

    await fillAndSubmit();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith('/reports?filter=x', { replace: true });
    });
  });

  it('refuses to be redirected off-site', async () => {
    // The block hands `returnTo` to the same validator the proxy uses, so an
    // injected absolute URL degrades to the dashboard rather than navigating.
    renderWithProviders(<SignInBlock returnTo="https://evil.example" />);

    await fillAndSubmit();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('revalidates the server-rendered tree after signing in', async () => {
    // The shell reads the session on the server; without this it could paint
    // the pre-sign-in payload for one navigation.
    renderWithProviders(<SignInBlock />);

    await fillAndSubmit();

    await waitFor(() => expect(revalidateSpy).toHaveBeenCalled());
  });
});

describe('validation', () => {
  it('does not call the server for an invalid email', async () => {
    renderWithProviders(<SignInBlock />);

    await fillAndSubmit('not-an-email');

    expect(
      await screen.findByText('That does not look like an email address.'),
    ).toBeInTheDocument();
    expect(authClientStub.signIn.email).not.toHaveBeenCalled();
  });

  it('marks the offending field for assistive technology', async () => {
    renderWithProviders(<SignInBlock />);

    await fillAndSubmit('not-an-email');

    const field = await screen.findByLabelText('Email address');

    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(field).toHaveAccessibleDescription(
      'That does not look like an email address.',
    );
  });
});

describe('failures', () => {
  it('shows one message for any credential failure', async () => {
    authClientStub.signIn.email.mockResolvedValue(
      fail('INVALID_EMAIL_OR_PASSWORD', 401),
    );

    renderWithProviders(<SignInBlock />);
    await fillAndSubmit();

    expect(
      await screen.findByText(
        'That email and password combination did not work.',
      ),
    ).toBeInTheDocument();
  });

  it('never reveals whether the account exists', async () => {
    authClientStub.signIn.email.mockResolvedValue(fail('USER_NOT_FOUND', 401));

    renderWithProviders(<SignInBlock />);
    await fillAndSubmit();

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(
      'That email and password combination did not work.',
    );
    expect(alert.textContent).not.toMatch(/not found|no account/i);
  });

  it('offers to resend when the address is unconfirmed', async () => {
    authClientStub.signIn.email.mockResolvedValue(
      fail('EMAIL_NOT_VERIFIED', 403),
    );

    renderWithProviders(<SignInBlock />);
    const user = await fillAndSubmit();

    expect(
      await screen.findByText('Confirm your email address before signing in.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send it again' }));

    // Reuses the address that was just typed — no second form, no URL.
    await waitFor(() => {
      expect(authClientStub.sendVerificationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'sara@example.com' }),
      );
    });
  });

  it('explains a deactivated account in its own words', async () => {
    authClientStub.signIn.email.mockResolvedValue(
      fail('ACCOUNT_DEACTIVATED', 403),
    );

    renderWithProviders(<SignInBlock />);
    await fillAndSubmit();

    expect(
      await screen.findByText(/This account has been deactivated/),
    ).toBeInTheDocument();
  });

  it('reports an unreachable server as a connection problem', async () => {
    authClientStub.signIn.email.mockRejectedValue(
      new TypeError('Failed to fetch'),
    );

    renderWithProviders(<SignInBlock />);
    await fillAndSubmit();

    expect(
      await screen.findByText(/could not reach the server/i),
    ).toBeInTheDocument();
  });

  it('shows the failure of a Google attempt that never got here', async () => {
    // Better Auth redirects to `errorCallbackURL?error=CODE` when the
    // provider round trip fails before this page loads.
    renderWithProviders(<SignInBlock providerError="PROVIDER_NOT_FOUND" />);

    expect(
      await screen.findByText(
        'Signing in with Google is unavailable right now.',
      ),
    ).toBeInTheDocument();
  });

  it('clears the banner once the user starts typing again', async () => {
    authClientStub.signIn.email.mockResolvedValue(
      fail('INVALID_EMAIL_OR_PASSWORD', 401),
    );

    renderWithProviders(<SignInBlock />);
    const user = await fillAndSubmit();

    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Password'), 'x');

    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
  });
});

describe('loading state', () => {
  it('disables the submit button while the request is in flight', async () => {
    let release: () => void = () => {};
    authClientStub.signIn.email.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ data: { redirect: false }, error: undefined });
      }),
    );

    renderWithProviders(<SignInBlock />);
    await fillAndSubmit();

    const button = screen.getByRole('button', { name: 'Sign in' });

    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute('aria-busy', 'true');

    release();
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});

describe('Google', () => {
  it('starts the flow with absolute, locale-carrying callbacks', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SignInBlock returnTo="/reports" />, { locale: 'en' });

    await user.click(
      screen.getByRole('button', { name: 'Continue with Google' }),
    );

    await waitFor(() => {
      expect(authClientStub.signIn.social).toHaveBeenCalledWith({
        provider: 'google',
        // Absolute, and carrying both prefixes. The backend redirects here
        // after Google, and neither Google nor an email client knows that
        // this application is mounted at /platform or that its locale is in
        // the path — a relative value would land on the API host.
        callbackURL: 'http://localhost:3000/platform/en/reports',
        errorCallbackURL: 'http://localhost:3000/platform/en/sign-in',
      });
    });
  });

  it('keeps Arabic through the round trip', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SignInBlock />, { locale: 'ar' });

    await user.click(
      screen.getByRole('button', { name: 'المتابعة باستخدام Google' }),
    );

    await waitFor(() => {
      expect(authClientStub.signIn.social).toHaveBeenCalledWith(
        // Every locale is prefixed: the router matches on a real segment.
        expect.objectContaining({
          callbackURL: 'http://localhost:3000/platform/ar',
        }),
      );
    });
  });
});

describe('localisation', () => {
  it('renders Arabic copy for Arabic readers', () => {
    renderWithProviders(<SignInBlock />, { locale: 'ar' });

    expect(
      screen.getByRole('heading', { name: 'تسجيل الدخول' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('البريد الإلكتروني')).toBeInTheDocument();
  });

  it('carries the interrupted destination into the sign-up link', () => {
    renderWithProviders(<SignInBlock returnTo="/reports" />);

    expect(
      screen.getByRole('link', { name: 'Create an account' }),
    ).toHaveAttribute('href', '/en/sign-up?returnTo=%2Freports');
  });
});
