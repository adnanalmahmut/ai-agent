import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_BASE_PATH } from '@/config/paths';
import { resetAuthClientStub } from '@/test/auth-client-stub';

/**
 * Route protection, over the **real** route tree.
 *
 * Every other test in this suite renders a component in isolation. This one
 * does the opposite on purpose: it builds the actual router from
 * `app/routes.tsx` and drives it by URL, because the properties worth checking
 * here are properties of the tree — which routes sit inside the protected
 * branch, whether a guard runs before an element is created, what a redirect
 * carries with it. None of that is visible from a component.
 *
 * The session read is the only thing stubbed. `fetchSession` is the single
 * function the whole boundary rests on, so replacing it is enough to say "this
 * visitor is signed in" without inventing a server.
 */
vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

const fetchSession = vi.fn();

vi.mock('@/features/auth/session', () => ({
  fetchSession: () => fetchSession(),
}));

const { createRoutes } = await import('./routes');

const SESSION = {
  user: {
    id: 'user_1',
    name: 'Sara Haddad',
    email: 'sara@example.com',
    emailVerified: true,
    image: null,
  },
  session: { id: 'session_1', token: 'token', userId: 'user_1' },
};

function visit(path: string) {
  // A fresh tree per test: React Router mutates the objects it is handed.
  const router = createMemoryRouter(createRoutes(), {
    basename: PLATFORM_BASE_PATH,
    initialEntries: [`${PLATFORM_BASE_PATH}${path}`],
  });

  render(<RouterProvider router={router} />);

  return router;
}

/**
 * Where the router ended up, once it has finished deciding.
 *
 * The mount point is stripped so the assertions read as application paths.
 * A memory router keeps it on `state.location`, unlike a browser one — which
 * is itself worth knowing: it is exactly why `returnPathFromUrl` removes the
 * base defensively rather than assuming which kind of location it was handed.
 */
async function settledAt(router: ReturnType<typeof createMemoryRouter>) {
  await waitFor(() => expect(router.state.initialized).toBe(true));
  await waitFor(() => expect(router.state.navigation.state).toBe('idle'));

  const { pathname, search } = router.state.location;

  return `${pathname.replace(PLATFORM_BASE_PATH, '')}${search}`;
}

beforeEach(() => {
  resetAuthClientStub();
  fetchSession.mockResolvedValue(null);
});

afterEach(() => {
  fetchSession.mockReset();
});

describe('an anonymous visitor', () => {
  it.each([
    ['/en', '/en/sign-in'],
    ['/en/organizations', '/en/sign-in?returnTo=%2Forganizations'],
    ['/en/design-system', '/en/sign-in?returnTo=%2Fdesign-system'],
    // A route nobody has written yet is already covered: private by placement.
    ['/en/organizations/org_1/members', '/en/sign-in?returnTo=%2Forganizations%2Forg_1%2Fmembers'],
  ])('is sent from %s to %s', async (from, expected) => {
    expect(await settledAt(visit(from))).toBe(expected);
  });

  it('keeps the query string of the interrupted destination', async () => {
    const at = await settledAt(visit('/en/organizations?tab=active'));

    expect(at).toBe('/en/sign-in?returnTo=%2Forganizations%3Ftab%3Dactive');
  });

  it('carries no returnTo when the destination was the dashboard', async () => {
    // `/` is where an unremembered sign-in lands anyway; carrying it would
    // only add noise to the URL.
    expect(await settledAt(visit('/en'))).toBe('/en/sign-in');
  });

  it('stays in Arabic when it was reading Arabic', async () => {
    expect(await settledAt(visit('/ar/organizations'))).toBe(
      '/ar/sign-in?returnTo=%2Forganizations',
    );
  });

  it.each([
    '/en/sign-in',
    '/en/sign-up',
    '/en/verify-email',
    '/en/forgot-password',
    '/en/reset-password',
    '/en/organizations/accept-invitation',
  ])('reaches %s', async (path) => {
    expect(await settledAt(visit(path))).toBe(path);
  });

  it('never renders the dashboard shell', async () => {
    const router = visit('/en/organizations');
    await settledAt(router);

    // The sidebar's landmark is the tell: if it exists at all, private
    // navigation was created for somebody who is not signed in.
    expect(
      screen.queryByRole('navigation', { name: 'Platform navigation' }),
    ).not.toBeInTheDocument();
  });
});

describe('a signed-in visitor', () => {
  beforeEach(() => {
    fetchSession.mockResolvedValue(SESSION);
  });

  it('reaches the dashboard', async () => {
    const router = visit('/en');

    expect(await settledAt(router)).toBe('/en');
    expect(
      await screen.findByRole('heading', { name: /Welcome back/ }),
    ).toBeInTheDocument();
  });

  it('gets the dashboard shell around it', async () => {
    visit('/en');

    expect(
      await screen.findByRole('button', {
        name: 'Show or hide the navigation',
      }),
    ).toBeInTheDocument();
  });

  it.each(['/en/sign-in', '/en/sign-up'])(
    'is bounced away from %s',
    async (path) => {
      expect(await settledAt(visit(path))).toBe('/en');
    },
  );

  it.each(['/en/verify-email', '/en/reset-password', '/en/forgot-password'])(
    'may still open %s',
    async (path) => {
      // Signing in does not mean the address is confirmed, and a reset link
      // from a mailbox has to work for somebody already signed in.
      expect(await settledAt(visit(path))).toBe(path);
    },
  );

  it('sees no dashboard navigation on an authentication page', async () => {
    visit('/en/verify-email');

    await waitFor(() =>
      expect(
        screen.queryByRole('navigation', { name: 'Platform navigation' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('asks the server for the session rather than trusting a cookie', async () => {
    visit('/en');

    await waitFor(() => expect(fetchSession).toHaveBeenCalled());
  });
});

describe('the locale is the routing source of truth', () => {
  // Signed in throughout, so what is being read is the locale decision rather
  // than a second redirect from the authentication boundary.
  beforeEach(() => {
    fetchSession.mockResolvedValue(SESSION);
  });

  it('sends a bare mount point to the default locale', async () => {
    expect(await settledAt(visit('/'))).toBe('/ar');
  });

  it('prefixes a link that forgot its locale', async () => {
    // `/organizations` is not a locale, so the whole path is treated as
    // locale-less and gains the default one.
    expect(await settledAt(visit('/organizations'))).toBe('/ar/organizations');
  });

  it('does not serve an unsupported locale as the default one', async () => {
    // `/fr/x` becomes `/ar/fr/x`, which matches nothing. Silently rendering
    // Arabic would claim we speak French.
    expect(await settledAt(visit('/fr/organizations'))).toBe(
      '/ar/fr/organizations',
    );
  });

  it('renders Arabic copy for an Arabic URL', async () => {
    visit('/ar');

    expect(
      await screen.findByRole('heading', { name: /أهلًا بعودتك/ }),
    ).toBeInTheDocument();
  });
});

describe('an address that leads nowhere', () => {
  it('is reported as not found rather than as a crash', async () => {
    fetchSession.mockResolvedValue(SESSION);
    visit('/en/nothing-here');

    expect(
      await screen.findByText('Page not found'),
    ).toBeInTheDocument();
  });

  it('offers the way back', async () => {
    fetchSession.mockResolvedValue(SESSION);
    visit('/en/nothing-here');

    expect(
      await screen.findByRole('link', { name: 'Go to the dashboard' }),
    ).toBeInTheDocument();
  });
});

describe('an unreachable API', () => {
  it('says so instead of pretending the visitor is signed out', async () => {
    // The distinction matters: dumping a working user onto a sign-in page
    // they also cannot reach is the worst of both answers.
    const { ApiUnavailableError } = await import('@/lib/application-api');
    fetchSession.mockRejectedValue(new ApiUnavailableError());

    visit('/en');

    expect(
      await screen.findByText('The platform is unreachable'),
    ).toBeInTheDocument();
  });
});
