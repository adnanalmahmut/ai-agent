import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { PasswordField } from './password-field';

function Field(props: { autoComplete: 'current-password' | 'new-password' }) {
  return (
    <PasswordField
      label="Password"
      value="hunter2"
      onChange={vi.fn()}
      {...props}
    />
  );
}

describe('PasswordField', () => {
  it('hides the value by default', () => {
    renderWithProviders(<Field autoComplete="current-password" />);

    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'type',
      'password',
    );
  });

  it('reveals and re-hides on demand', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Field autoComplete="current-password" />);

    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'type',
      'password',
    );
  });

  it('gives the toggle a name and a state, not just an icon', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Field autoComplete="current-password" />);

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle);
    expect(
      screen.getByRole('button', { name: 'Hide password' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('is reachable by keyboard', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Field autoComplete="current-password" />);

    await user.tab();
    expect(screen.getByLabelText('Password')).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus();
  });

  it.each(['current-password', 'new-password'] as const)(
    'passes autocomplete=%s to the browser',
    (autoComplete) => {
      renderWithProviders(<Field autoComplete={autoComplete} />);

      expect(screen.getByLabelText('Password')).toHaveAttribute(
        'autocomplete',
        autoComplete,
      );
    },
  );

  it('names the toggle in Arabic too', () => {
    renderWithProviders(<Field autoComplete="current-password" />, {
      locale: 'ar',
    });

    expect(
      screen.getByRole('button', { name: 'إظهار كلمة المرور' }),
    ).toBeInTheDocument();
  });
});
