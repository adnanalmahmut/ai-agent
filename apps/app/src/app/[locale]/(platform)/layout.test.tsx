import { useQueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReactNode } from 'react';

import { AUTH_ROUTES, RETURN_TO_PARAM } from '@/features/auth/routes';
import type { PlatformSession } from '@/features/auth/session-types';

/**
 * The protected route group has exactly one gate: this layout. Every private
 * page renders inside it, so the tests below are the behavioural statement of
 * that boundary — an anonymous request never reaches the shell, and the path
 * it was interrupted on survives the round trip only when it is safe to
 * replay.
 */

const getServerSession = vi.fn<() => Promise<PlatformSession | null>>();
const redirect = vi.fn();
const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

const requestHeaders = new Headers();

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(requestHeaders),
}));
vi.mock('next/navigation', () => ({ notFound: () => notFound() }));
vi.mock('@/features/auth/server-session', () => ({
  getServerSession: () => getServerSession(),
}));
vi.mock('@/i18n/server-navigation', () => ({
  redirect: (options: unknown) => redirect(options),
}));
vi.mock('@/features/platform-shell/platform-shell', () => ({
  PlatformShell: ({ children }: { children: ReactNode }) => children,
}));

const { default: ProtectedLayout } = await import('./layout');

const SESSION = {
  user: { id: 'user_1' },
} as unknown as PlatformSession;

const renderLayout = (locale = 'en', children: ReactNode = null) =>
  ProtectedLayout({
    children,
    params: Promise.resolve({ locale }),
  });

const interruptedAt = (path: string) =>
  requestHeaders.set('x-platform-return-to', path);

describe('the protected route group', () => {
  beforeEach(() => {
    requestHeaders.delete('x-platform-return-to');
    vi.clearAllMocks();
  });

  it('sends an anonymous visitor to sign-in instead of rendering the shell', async () => {
    getServerSession.mockResolvedValue(null);

    const rendered = await renderLayout();

    expect(rendered).toBeUndefined();
    expect(redirect).toHaveBeenCalledWith({
      href: AUTH_ROUTES.signIn,
      locale: 'en',
    });
  });

  it('keeps the page the visitor was interrupted on', async () => {
    getServerSession.mockResolvedValue(null);
    interruptedAt('/platform/en/organizations/org_1/members?tab=active');

    await renderLayout();

    expect(redirect).toHaveBeenCalledWith({
      href: {
        pathname: AUTH_ROUTES.signIn,
        query: {
          [RETURN_TO_PARAM]: '/organizations/org_1/members?tab=active',
        },
      },
      locale: 'en',
    });
  });

  it('refuses to replay a return path that leaves the application', async () => {
    getServerSession.mockResolvedValue(null);
    interruptedAt('//evil.example/platform/en');

    await renderLayout();

    expect(redirect).toHaveBeenCalledWith({
      href: AUTH_ROUTES.signIn,
      locale: 'en',
    });
  });

  it('refuses to replay the sign-in page itself', async () => {
    getServerSession.mockResolvedValue(null);
    interruptedAt('/platform/en/sign-in');

    await renderLayout();

    expect(redirect).toHaveBeenCalledWith({
      href: AUTH_ROUTES.signIn,
      locale: 'en',
    });
  });

  it('renders the shell once there is a session', async () => {
    getServerSession.mockResolvedValue(SESSION);
    interruptedAt('/platform/en/organizations');

    const rendered = await renderLayout();

    expect(redirect).not.toHaveBeenCalled();
    expect(rendered).toBeTruthy();
  });

  it('asks for the session before deciding anything', async () => {
    getServerSession.mockResolvedValue(null);

    await renderLayout();

    expect(getServerSession).toHaveBeenCalledTimes(1);
  });

  it('gives the private tree a query client to hold its server state', async () => {
    getServerSession.mockResolvedValue(SESSION);

    function QueryClientProbe() {
      useQueryClient();

      return <p>reached</p>;
    }

    const rendered = await renderLayout('en', <QueryClientProbe />);

    // `useQueryClient` throws without a provider above it, so rendering at
    // all is the assertion: the protected boundary is where the client is
    // mounted, and it is mounted around the shell rather than inside it.
    render(rendered as ReactNode);

    expect(screen.getByText('reached')).toBeInTheDocument();
  });

  it('rejects a locale the application does not serve', async () => {
    getServerSession.mockResolvedValue(SESSION);

    await expect(renderLayout('fr')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(redirect).not.toHaveBeenCalled();
  });
});
