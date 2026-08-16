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

const { ResetPasswordBlock } = await import('./reset-password-block');

const TOKEN = 'reset-token-from-the-email';

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
});

async function submit(
  password = 'a-good-password',
  confirmation = 'a-good-password',
) {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText('New password'), password);
  await user.type(screen.getByLabelText('Confirm new password'), confirmation);
  await user.click(screen.getByRole('button', { name: 'Save new password' }));

  return user;
}

describe('with a usable token', () => {
  it('sends the new password with the token', async () => {
    renderWithProviders(<ResetPasswordBlock token={TOKEN} />);

    await submit();

    await waitFor(() => {
      expect(authClientStub.resetPassword).toHaveBeenCalledWith({
        newPassword: 'a-good-password',
        token: TOKEN,
      });
    });
  });

  it('confirms and offers the way back', async () => {
    renderWithProviders(<ResetPasswordBlock token={TOKEN} />);

    await submit();

    expect(await screen.findByText('Password updated')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Go to sign in' }),
    ).toHaveAttribute('href', '/en/sign-in');
  });

  it('refuses a mismatched confirmation without calling the server', async () => {
    renderWithProviders(<ResetPasswordBlock token={TOKEN} />);

    await submit('a-good-password', 'a-different-one');

    expect(
      await screen.findByText('The two passwords do not match.'),
    ).toBeInTheDocument();
    expect(authClientStub.resetPassword).not.toHaveBeenCalled();
  });

  it('reports a token the server rejects', async () => {
    authClientStub.resetPassword.mockResolvedValue(fail('INVALID_TOKEN', 400));

    renderWithProviders(<ResetPasswordBlock token={TOKEN} />);
    await submit();

    expect(
      await screen.findByText('This link is not valid.'),
    ).toBeInTheDocument();
  });

  it('never puts the token on the screen', async () => {
    // It is a credential. It arrives in the URL because that is where Better
    // Auth's redirect puts it, and it goes exactly one place from there.
    authClientStub.resetPassword.mockResolvedValue(fail('INVALID_TOKEN', 400));

    const { container } = renderWithProviders(<ResetPasswordBlock token={TOKEN} />);
    await submit();

    await screen.findByRole('alert');

    expect(container.textContent).not.toContain(TOKEN);
  });
});

describe('without a usable token', () => {
  it('explains rather than showing an unusable form', async () => {
    renderWithProviders(<ResetPasswordBlock />);

    expect(
      await screen.findByText('This link cannot be used'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('distinguishes an expired link from an invalid one', async () => {
    // Better Auth appends its own code when it turns the emailed link away.
    renderWithProviders(<ResetPasswordBlock callbackError="TOKEN_EXPIRED" />);

    expect(
      await screen.findByText('This link has expired.'),
    ).toBeInTheDocument();
  });

  it('offers a way to request another one', async () => {
    renderWithProviders(<ResetPasswordBlock />);

    expect(
      await screen.findByRole('link', { name: 'Request a new link' }),
    ).toHaveAttribute('href', '/en/forgot-password');
  });
});

describe('localisation', () => {
  it('renders Arabic copy', () => {
    renderWithProviders(<ResetPasswordBlock token={TOKEN} />, { locale: 'ar' });

    expect(screen.getByText('اختر كلمة مرور جديدة')).toBeInTheDocument();
    expect(screen.getByLabelText('كلمة المرور الجديدة')).toBeInTheDocument();
  });
});
