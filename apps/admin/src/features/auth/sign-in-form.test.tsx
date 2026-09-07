import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';
import { replaceSpy, resetNavigationStub } from '@/test/navigation-stub';

const signInEmail = vi.fn();
const signOut = vi.fn();

vi.mock('./auth-client', () => ({
  authClient: {
    signIn: { email: (input: unknown) => signInEmail(input) },
    signOut: () => signOut(),
  },
}));

const { SignInForm } = await import('./sign-in-form');
const { ADMIN_ROUTES } = await import('./routes');

async function fillAndSubmit(email: string, password: string) {
  const user = userEvent.setup();

  if (email) await user.type(screen.getByLabelText('Email'), email);
  if (password) await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('signing in to the administrative workspace', () => {
  beforeEach(() => {
    resetNavigationStub();
    vi.clearAllMocks();
  });

  it('authenticates through the existing session mechanism', async () => {
    signInEmail.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    renderWithProviders(<SignInForm />);

    await fillAndSubmit('staff@example.com', 'correct-horse');

    expect(signInEmail).toHaveBeenCalledWith({
      email: 'staff@example.com',
      password: 'correct-horse',
    });
  });

  it('hands the access decision to the server rather than taking it here', async () => {
    signInEmail.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    renderWithProviders(<SignInForm />);

    await fillAndSubmit('staff@example.com', 'correct-horse');

    // Straight to the workspace. Whether this session is a staff session is
    // the protected layout's question, asked once, on the server.
    await waitFor(() =>
      expect(replaceSpy).toHaveBeenCalledWith(ADMIN_ROUTES.workspace),
    );
  });

  it('says the same thing however the credentials were wrong', async () => {
    signInEmail.mockResolvedValue({ data: null, error: { status: 401 } });
    renderWithProviders(<SignInForm />);

    await fillAndSubmit('staff@example.com', 'wrong');

    expect(
      await screen.findByText('Those credentials were not accepted.'),
    ).toBeInTheDocument();
    // Which half was wrong, and whether the address belongs to an account at
    // all, is not this form's to disclose.
    expect(screen.queryByText(/password/i)).not.toHaveAttribute('role', 'alert');
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('reports a transport failure as a transport failure', async () => {
    signInEmail.mockRejectedValue(new Error('offline'));
    renderWithProviders(<SignInForm />);

    await fillAndSubmit('staff@example.com', 'correct-horse');

    expect(
      await screen.findByText(/Sign in is unavailable right now/),
    ).toBeInTheDocument();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('validates before it reaches the network', async () => {
    renderWithProviders(<SignInForm />);

    await fillAndSubmit('', '');

    expect(
      await screen.findByText('Enter your email address.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it('rejects an address that is not one', async () => {
    renderWithProviders(<SignInForm />);

    await fillAndSubmit('staff@', 'correct-horse');

    expect(
      await screen.findByText('Enter a valid email address.'),
    ).toBeInTheDocument();
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it('offers no way to create an account', () => {
    renderWithProviders(<SignInForm />);

    // Not a route, not a link, not a button: staff are provisioned through
    // the existing account administration.
    expect(screen.queryAllByRole('link')).toEqual([]);
    expect(
      screen.queryByText(/sign ?up|register|create an account/i),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('renders in Arabic when the reader is reading Arabic', () => {
    renderWithProviders(<SignInForm />, { locale: 'ar' });

    expect(screen.getByLabelText('البريد الإلكتروني')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'تسجيل الدخول' }),
    ).toBeInTheDocument();
  });
});
