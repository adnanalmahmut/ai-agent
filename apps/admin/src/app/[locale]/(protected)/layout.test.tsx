import { render } from '@testing-library/react';
import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAccess } from '@/features/auth/admin-access';
import { ADMIN_ROUTES } from '@/features/auth/routes';

/**
 * The protected route group has exactly one gate: this layout. The statement
 * below is the behavioural form of default deny — `children` is reached on
 * one branch and every other outcome, including one nobody anticipated,
 * renders a refusal instead.
 */

const resolveAdminAccess = vi.fn<() => Promise<AdminAccess>>();
const redirect = vi.fn();
const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({ notFound: () => notFound() }));
vi.mock('@/features/auth/admin-access', () => ({
  resolveAdminAccess: () => resolveAdminAccess(),
}));
vi.mock('@/i18n/server-navigation', () => ({
  redirect: (options: unknown) => redirect(options),
}));
vi.mock('@/features/auth/access-notice', () => ({
  ForbiddenNotice: () => 'forbidden-notice',
  UnavailableNotice: () => 'unavailable-notice',
}));
vi.mock('@/features/shell/admin-shell', () => ({
  AdminShell: ({ children }: { children: ReactNode }) => children,
}));

const { default: ProtectedLayout } = await import('./layout');

const PROTECTED = 'protected-content';

const renderLayout = (locale = 'en') =>
  ProtectedLayout({
    children: PROTECTED,
    params: Promise.resolve({ locale }),
  });

/** What the layout put on the page, whatever branch it took. */
async function renderedText(locale = 'en'): Promise<string> {
  const output = await renderLayout(locale);

  // A redirect renders nothing at all, which is itself an answer.
  if (!isValidElement(output)) return '';

  return render(output).container.textContent ?? '';
}

describe('the administrative gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends an anonymous request to sign in rather than rendering the shell', async () => {
    resolveAdminAccess.mockResolvedValue({ kind: 'anonymous' });

    const rendered = await renderedText();

    expect(redirect).toHaveBeenCalledWith({
      href: ADMIN_ROUTES.signIn,
      locale: 'en',
    });
    expect(rendered).not.toContain(PROTECTED);
  });

  it('renders the workspace for an authorized staff session', async () => {
    resolveAdminAccess.mockResolvedValue({
      kind: 'granted',
      session: { user: { id: 'u1', email: 'staff@example.com', role: 'admin' } },
    });

    expect(await renderedText()).toContain(PROTECTED);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('refuses an authenticated account that is not staff, in place', async () => {
    resolveAdminAccess.mockResolvedValue({ kind: 'denied' });

    const rendered = await renderedText();

    // Not a redirect to sign in: telling somebody who is signed in that they
    // are signed out is both false and confusing.
    expect(redirect).not.toHaveBeenCalled();
    expect(rendered).toContain('forbidden-notice');
    expect(rendered).not.toContain(PROTECTED);
  });

  it('refuses rather than renders when access could not be established', async () => {
    resolveAdminAccess.mockResolvedValue({ kind: 'unavailable' });

    const rendered = await renderedText();

    expect(rendered).toContain('unavailable-notice');
    expect(rendered).not.toContain(PROTECTED);
  });

  it('denies an outcome it does not recognise', async () => {
    // The compiler makes this unreachable; the point is that the code has no
    // permissive fallback if it ever became reachable.
    resolveAdminAccess.mockResolvedValue({
      kind: 'something-new',
    } as unknown as AdminAccess);

    const rendered = await renderedText();

    expect(rendered).toContain('forbidden-notice');
    expect(rendered).not.toContain(PROTECTED);
  });

  it('does not evaluate access for an unsupported locale', async () => {
    resolveAdminAccess.mockResolvedValue({ kind: 'granted' } as AdminAccess);

    await expect(renderLayout('de')).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
