import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authClientStub,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { context, organization } from '@/test/organization-fixtures';
import { renderInOrganization } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');

  return { authClient: authClientStub };
});

const listContentProjects = vi.fn();

vi.mock('../organization-api', async () => {
  const actual = await vi.importActual<typeof import('../organization-api')>(
    '../organization-api',
  );

  return {
    ...actual,
    listContentProjects: (...args: unknown[]) => listContentProjects(...args),
  };
});

const { OrganizationContentProjectsBlock } = await import(
  './organization-content-projects-block'
);

const project = (overrides: Record<string, unknown> = {}) => ({
  id: 'proj_1',
  organizationId: 'org_1',
  sourceRunId: 'run_1',
  sourceIdeaIndex: 0,
  title: 'Kettle teardown',
  hook: 'What is actually inside a cheap kettle?',
  angle: 'Cost breakdown as a trust signal',
  summary: 'Open one up on camera and cost each part.',
  suggestedFormat: 'video',
  language: 'en',
  createdByUserId: 'user_1',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  ...overrides,
});

const render = () =>
  renderInOrganization(
    <OrganizationContentProjectsBlock />,
    context({ organization: organization() }),
  );

describe('organization content projects block', () => {
  beforeEach(() => {
    resetAuthClientStub();
    authClientStub.organization.checkRolePermission.mockReturnValue(true);
    listContentProjects.mockReset();
  });

  it('lists what the organization has committed to', async () => {
    listContentProjects.mockResolvedValue({
      items: [project(), project({ id: 'proj_2', title: 'Morning ritual' })],
      nextCursor: null,
    });

    render();

    expect(await screen.findByText('Kettle teardown')).toBeInTheDocument();
    expect(screen.getByText('Morning ritual')).toBeInTheDocument();
  });

  it('says so when there is nothing yet', async () => {
    listContentProjects.mockResolvedValue({ items: [], nextCursor: null });

    render();

    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument();
  });

  /**
   * The second page is appended, not swapped in.
   *
   * A "load more" that replaced the list would read as the first page having
   * vanished, which is indistinguishable from a bug in the cursor.
   */
  it('appends the next page rather than replacing the first', async () => {
    listContentProjects
      .mockResolvedValueOnce({ items: [project()], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({
        items: [project({ id: 'proj_2', title: 'Morning ritual' })],
        nextCursor: null,
      });

    render();

    await screen.findByText('Kettle teardown');
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Morning ritual')).toBeInTheDocument();
    // Still there.
    expect(screen.getByText('Kettle teardown')).toBeInTheDocument();

    expect(listContentProjects).toHaveBeenLastCalledWith(
      'org_1',
      expect.objectContaining({ cursor: 'cursor-1' }),
    );
  });

  it('offers a retry when the list cannot be read', async () => {
    listContentProjects.mockRejectedValueOnce(new Error('nope'));

    render();

    expect(
      await screen.findByText(/projects could not be loaded/i),
    ).toBeInTheDocument();

    listContentProjects.mockResolvedValueOnce({
      items: [project()],
      nextCursor: null,
    });

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() =>
      expect(screen.getByText('Kettle teardown')).toBeInTheDocument(),
    );
  });
});
