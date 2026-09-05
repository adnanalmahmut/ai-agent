import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformSession } from '@/features/auth/session-types';
import type { OrganizationData } from '../route-data';
import { refreshSpy, resetNavigationStub } from '@/test/navigation-stub';
import { organization } from '@/test/organization-fixtures';
import { renderWithProviders } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');
  return { authClient: authClientStub };
});

vi.mock('@/i18n/navigation', async () => import('@/test/navigation-stub'));

const restoreOrganization = vi.fn();

vi.mock('../organization-api', () => ({
  archiveOrganization: vi.fn(),
  restoreOrganization: (...args: unknown[]) => restoreOrganization(...args),
  listArchivedOrganizations: vi.fn(),
}));

const { OrganizationShellBlock } = await import('./organization-shell-block');

const SESSION = {
  user: {
    id: 'user_owner',
    name: 'Sara Haddad',
    email: 'sara@example.com',
    emailVerified: true,
    image: null,
  },
  session: { id: 'session_1', token: 'token', userId: 'user_owner' },
};

function renderShell(data: OrganizationData, tab = <span>tab</span>) {
  return renderWithProviders(
    <OrganizationShellBlock data={data}>{tab}</OrganizationShellBlock>,
    { session: SESSION as PlatformSession },
  );
}

beforeEach(() => {
  resetNavigationStub();
  restoreOrganization.mockReset();
  restoreOrganization.mockResolvedValue({ organizationId: 'org_1' });
});

describe('a loaded organization', () => {
  const ready: OrganizationData = {
    state: 'ready',
    organization: organization(),
  };

  it('names it once, as the page heading', async () => {
    renderShell(ready);

    expect(
      await screen.findByRole('heading', { name: 'Acme Research' }),
    ).toBeInTheDocument();
  });

  it('shows the reader’s role in this organization', async () => {
    renderShell(ready);

    expect(await screen.findByText('Owner')).toBeInTheDocument();
  });

  it('offers its four sections', async () => {
    renderShell(ready);

    const tabs = await screen.findByRole('navigation', {
      name: 'Organization sections',
    });

    for (const label of ['Overview', 'Members', 'Invitations', 'Settings']) {
      expect(
        within(tabs).getByRole('link', { name: label }),
      ).toBeInTheDocument();
    }
  });

  it('renders the tab below it', async () => {
    renderShell(ready, <span>the members tab</span>);

    expect(await screen.findByText('the members tab')).toBeInTheDocument();
  });
});

describe('an archived organization', () => {
  it('explains the state instead of failing', async () => {
    renderShell({
      state: 'archived',
      organizationId: 'org_1',
      restorable: null,
    });

    expect(
      await screen.findByText('This organization is archived'),
    ).toBeInTheDocument();
  });

  it('says nothing was deleted', async () => {
    renderShell({
      state: 'archived',
      organizationId: 'org_1',
      restorable: null,
    });

    expect(
      await screen.findByText('Members keep their places — nobody is removed.'),
    ).toBeInTheDocument();
  });

  it('offers no restore when the server did not list it as restorable', async () => {
    renderShell({
      state: 'archived',
      organizationId: 'org_1',
      restorable: null,
    });

    await screen.findByText('This organization is archived');
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('restores when it did', async () => {
    renderShell({
      state: 'archived',
      organizationId: 'org_1',
      restorable: {
        id: 'org_1',
        name: 'Acme Research',
        slug: 'acme-research',
        archivedAt: '2026-06-01T00:00:00.000Z',
        canRestore: true,
      },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore' }));

    await waitFor(() =>
      expect(restoreOrganization).toHaveBeenCalledWith('org_1'),
    );
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('renders no tab underneath', async () => {
    renderShell(
      { state: 'archived', organizationId: 'org_1', restorable: null },
      <span>the members tab</span>,
    );

    await screen.findByText('This organization is archived');
    expect(screen.queryByText('the members tab')).toBeNull();
  });
});

describe('an organization that could not be opened', () => {
  it('gives one answer for every remaining reason', async () => {
    renderShell({ state: 'error', error: 'NOT_A_MEMBER' });

    expect(
      await screen.findByText('This organization could not be opened'),
    ).toBeInTheDocument();
  });

  it('renders no tab underneath', async () => {
    renderShell(
      { state: 'error', error: 'UNKNOWN' },
      <span>the members tab</span>,
    );

    await screen.findByText('This organization could not be opened');
    expect(screen.queryByText('the members tab')).toBeNull();
  });
});
