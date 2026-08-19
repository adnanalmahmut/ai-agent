import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SidebarProvider } from '@repo/ui';

import { authClientStub, resetAuthClientStub } from '@/test/auth-client-stub';
import { resetNavigationStub } from '@/test/navigation-stub';
import { renderWithProviders } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

/** The sidebar reads the current organization from the route's loader data. */
const routeData = vi.fn<() => unknown>(() => undefined);

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>(
    'react-router',
  );

  return {
    ...actual,
    useRouteLoaderData: (id: string) => {
      if (id === 'protected') {
        return {
          user: { name: 'Sara Haddad', email: 'sara@example.com', image: null },
          session: {},
        };
      }
      return routeData();
    },
  };
});

const { PlatformSidebar } = await import('./platform-sidebar');

function renderSidebar(locale: 'en' | 'ar' = 'en') {
  return renderWithProviders(
    <SidebarProvider>
      <PlatformSidebar />
    </SidebarProvider>,
    { locale },
  );
}

beforeEach(() => {
  resetAuthClientStub();
  resetNavigationStub();
  routeData.mockReturnValue(undefined);
});

describe('the primary navigation', () => {
  it('always offers the dashboard and the organizations list', () => {
    renderSidebar();

    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'href',
      '/en',
    );
    expect(screen.getByRole('link', { name: 'Organizations' })).toHaveAttribute(
      'href',
      '/en/organizations',
    );
  });

  it('is translated', () => {
    renderSidebar('ar');

    expect(screen.getByRole('link', { name: 'لوحة التحكم' })).toBeInTheDocument();
  });
});

describe('the organization section', () => {
  it('is absent when there is no organization in context', () => {
    // A reader who belongs to none would otherwise be offered four links that
    // all lead to a page explaining that they belong to none.
    renderSidebar();

    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Invitations' })).toBeNull();
  });

  it('appears for the organization the reader is looking at', () => {
    // The route's organization wins over the active one: showing the active
    // organization's sections while reading another would be navigation that
    // lies about where its links go.
    routeData.mockReturnValue({
      state: 'ready',
      organization: { id: 'org_route', name: 'Route Org' },
    });

    renderSidebar();

    expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute(
      'href',
      '/en/organizations/org_route/members',
    );
    expect(screen.getByText('Route Org')).toBeInTheDocument();
  });

  it('falls back to the active organization elsewhere', () => {
    authClientStub.useActiveOrganization.mockReturnValue({
      data: { id: 'org_active', name: 'Active Org' },
      isPending: false,
    });

    renderSidebar();

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/en/organizations/org_active/settings',
    );
  });

  it('shows nothing for an organization that failed to load', () => {
    routeData.mockReturnValue({ state: 'error', error: 'NOT_A_MEMBER' });

    renderSidebar();

    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull();
  });
});

describe('what the sidebar is not', () => {
  it('grants nothing — an organization in context is not permission', () => {
    // The sections appear because there is something to look at, not because
    // the reader may act on it. Each page asks its own permission, and the
    // server asks again.
    routeData.mockReturnValue({
      state: 'ready',
      organization: { id: 'org_1', name: 'Acme' },
    });

    renderSidebar();

    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(
      authClientStub.organization.checkRolePermission,
    ).not.toHaveBeenCalled();
  });
});
