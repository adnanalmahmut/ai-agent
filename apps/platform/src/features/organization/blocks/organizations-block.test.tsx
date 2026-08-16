import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetNavigationStub, revalidateSpy } from '@/test/navigation-stub';
import { renderWithProviders } from '@/test/render';

import type { OrganizationsListData } from '../loaders';

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

const { OrganizationsBlock } = await import('./organizations-block');

const summary = (id: string, name: string) => ({
  id,
  name,
  slug: name.toLowerCase().replace(/\s+/g, '-'),
  logo: null,
});

const data = (
  overrides: Partial<OrganizationsListData> = {},
): OrganizationsListData => ({
  organizations: [],
  archived: [],
  error: null,
  ...overrides,
});

beforeEach(() => {
  resetNavigationStub();
  restoreOrganization.mockReset();
  restoreOrganization.mockResolvedValue({ organizationId: 'org_x' });
});

describe('with no organizations', () => {
  it('explains the state instead of showing an empty panel', () => {
    renderWithProviders(<OrganizationsBlock data={data()} />);

    expect(
      screen.getByText('You are not in any organization yet'),
    ).toBeInTheDocument();
  });

  it('offers the way out of it', () => {
    // Before organization creation existed this state could only apologise.
    renderWithProviders(<OrganizationsBlock data={data()} />);

    expect(
      screen.getByRole('link', { name: 'New organization' }),
    ).toHaveAttribute('href', '/en/organizations/new');
  });
});

describe('with organizations', () => {
  it('lists one', () => {
    renderWithProviders(
      <OrganizationsBlock
        data={data({ organizations: [summary('org_1', 'Acme Research')] })}
      />,
    );

    expect(screen.getByText('Acme Research')).toBeInTheDocument();
  });

  it('lists several, each linking to itself', () => {
    renderWithProviders(
      <OrganizationsBlock
        data={data({
          organizations: [
            summary('org_1', 'Acme Research'),
            summary('org_2', 'Beta Works'),
            summary('org_3', 'Gamma Trust'),
          ],
        })}
      />,
    );

    expect(screen.getAllByRole('link')).toHaveLength(4);
    expect(
      screen.getByRole('link', { name: /Beta Works/ }),
    ).toHaveAttribute('href', '/en/organizations/org_2');
  });

  it('does not show the empty state', () => {
    renderWithProviders(
      <OrganizationsBlock
        data={data({ organizations: [summary('org_1', 'Acme Research')] })}
      />,
    );

    expect(screen.queryByText('You are not in any organization yet')).toBeNull();
  });
});

describe('archived organizations', () => {
  const archived = {
    id: 'org_9',
    name: 'Retired Unit',
    slug: 'retired-unit',
    archivedAt: '2026-06-01T00:00:00.000Z',
    canRestore: true,
  };

  it('are absent from the normal list', () => {
    // Better Auth's own list filters them out; nothing here puts them back.
    renderWithProviders(
      <OrganizationsBlock
        data={data({ organizations: [summary('org_1', 'Acme Research')] })}
      />,
    );

    expect(screen.queryByText('Archived')).toBeNull();
  });

  it('get their own quiet section when there are any', () => {
    renderWithProviders(
      <OrganizationsBlock data={data({ archived: [archived] })} />,
    );

    expect(screen.getByText('Retired Unit')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Archived' }),
    ).toBeInTheDocument();
  });

  it('offer restore only when the server said this caller may', () => {
    // There is no role check here and there could not be one: the answer
    // arrived pre-decided from the endpoint that will enforce it.
    renderWithProviders(
      <OrganizationsBlock
        data={data({ archived: [{ ...archived, canRestore: false }] })}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('restore and revalidate', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <OrganizationsBlock data={data({ archived: [archived] })} />,
    );

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(restoreOrganization).toHaveBeenCalledWith('org_9'));
    expect(revalidateSpy).toHaveBeenCalled();
  });

  it('report a failed restore in place', async () => {
    const { ApiError } = await import('@/lib/application-api');
    restoreOrganization.mockRejectedValue(new ApiError(403, 'FORBIDDEN'));

    const user = userEvent.setup();
    renderWithProviders(
      <OrganizationsBlock data={data({ archived: [archived] })} />,
    );

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(
      await screen.findByText(
        'You do not have permission to do that in this organization.',
      ),
    ).toBeInTheDocument();
  });
});

describe('when the list could not be loaded', () => {
  it('says so rather than claiming there are none', () => {
    // "You are in no organizations" and "we could not ask" are different
    // facts, and only one of them suggests creating one.
    renderWithProviders(
      <OrganizationsBlock data={data({ error: 'NETWORK_ERROR' })} />,
    );

    expect(
      screen.getByText(
        'We could not reach the server. Check your connection and try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('You are not in any organization yet')).toBeNull();
  });
});
