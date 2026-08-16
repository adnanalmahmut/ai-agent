import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authClientStub, resetAuthClientStub } from '@/test/auth-client-stub';
import { renderWithProviders } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const { GlobalPermissionGate, OrganizationPermissionGate } = await import(
  './permission-gate'
);

beforeEach(resetAuthClientStub);

const signedInAs = (role: string | null) =>
  authClientStub.useSession.mockReturnValue({
    data: { user: { role }, session: {} },
    isPending: false,
  } as never);

const memberAs = (role: string | null) =>
  authClientStub.useActiveMember.mockReturnValue({
    data: role === null ? null : { role },
    isPending: false,
  } as never);

describe('GlobalPermissionGate', () => {
  it('renders nothing when the permission is absent', () => {
    signedInAs('user');
    authClientStub.admin.checkRolePermission.mockReturnValue(false);

    renderWithProviders(
      <GlobalPermissionGate permissions={{ user: ['list'] }}>
        <span>secret</span>
      </GlobalPermissionGate>,
    );

    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('renders the children when it is present', () => {
    signedInAs('admin');
    authClientStub.admin.checkRolePermission.mockReturnValue(true);

    renderWithProviders(
      <GlobalPermissionGate permissions={{ user: ['list'] }}>
        <span>secret</span>
      </GlobalPermissionGate>,
    );

    expect(screen.getByText('secret')).toBeInTheDocument();
  });

  it('asks about the permission, never about the role name', () => {
    signedInAs('admin');
    authClientStub.admin.checkRolePermission.mockReturnValue(true);

    renderWithProviders(
      <GlobalPermissionGate permissions={{ user: ['list'] }}>
        <span>secret</span>
      </GlobalPermissionGate>,
    );

    expect(authClientStub.admin.checkRolePermission).toHaveBeenCalledWith({
      role: 'admin',
      permissions: { user: ['list'] },
    });
  });

  it('closes for a signed-out visitor', () => {
    authClientStub.useSession.mockReturnValue({
      data: null,
      isPending: false,
    });

    renderWithProviders(
      <GlobalPermissionGate permissions={{ user: ['list'] }}>
        <span>secret</span>
      </GlobalPermissionGate>,
    );

    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(authClientStub.admin.checkRolePermission).not.toHaveBeenCalled();
  });

  it('closes when the session carries no role at all', () => {
    signedInAs(null);

    renderWithProviders(
      <GlobalPermissionGate permissions={{ user: ['list'] }}>
        <span>secret</span>
      </GlobalPermissionGate>,
    );

    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('shows a fallback when one is given', () => {
    signedInAs('user');

    renderWithProviders(
      <GlobalPermissionGate
        permissions={{ user: ['list'] }}
        fallback={<span>nothing to see</span>}
      >
        <span>secret</span>
      </GlobalPermissionGate>,
    );

    expect(screen.getByText('nothing to see')).toBeInTheDocument();
  });
});

describe('OrganizationPermissionGate', () => {
  it('reads the member role, not the platform role', () => {
    // The two domains are separate. A platform super_admin is nobody inside
    // an organization they have no membership in.
    signedInAs('super_admin');
    memberAs(null);

    renderWithProviders(
      <OrganizationPermissionGate permissions={{ invitation: ['create'] }}>
        <span>invite</span>
      </OrganizationPermissionGate>,
    );

    expect(screen.queryByText('invite')).not.toBeInTheDocument();
    expect(
      authClientStub.organization.checkRolePermission,
    ).not.toHaveBeenCalled();
  });

  it('opens for a member whose role carries the permission', () => {
    memberAs('owner');
    authClientStub.organization.checkRolePermission.mockReturnValue(true);

    renderWithProviders(
      <OrganizationPermissionGate permissions={{ organization: ['archive'] }}>
        <span>archive</span>
      </OrganizationPermissionGate>,
    );

    expect(screen.getByText('archive')).toBeInTheDocument();
    expect(
      authClientStub.organization.checkRolePermission,
    ).toHaveBeenCalledWith({
      role: 'owner',
      permissions: { organization: ['archive'] },
    });
  });

  it('never consults the global evaluator', () => {
    // Passing an organization permission to the platform catalogue is the
    // mistake the two separate components exist to prevent.
    memberAs('admin');
    authClientStub.organization.checkRolePermission.mockReturnValue(true);

    renderWithProviders(
      <OrganizationPermissionGate permissions={{ member: ['create'] }}>
        <span>add</span>
      </OrganizationPermissionGate>,
    );

    expect(authClientStub.admin.checkRolePermission).not.toHaveBeenCalled();
  });

  it('is context-blind: an active organization alone grants nothing', () => {
    // Mirrors the backend invariant. A session can name an organization the
    // user is not a member of; that is context, never access.
    authClientStub.useActiveOrganization.mockReturnValue({
      data: { id: 'org_1', name: 'Acme' },
      isPending: false,
    } as never);
    memberAs(null);

    renderWithProviders(
      <OrganizationPermissionGate permissions={{ organization: ['update'] }}>
        <span>edit</span>
      </OrganizationPermissionGate>,
    );

    expect(screen.queryByText('edit')).not.toBeInTheDocument();
  });
});
