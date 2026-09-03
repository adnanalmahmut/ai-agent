import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authClientStub, resetAuthClientStub } from '@/test/auth-client-stub';
import { context, organization } from '@/test/organization-fixtures';
import { renderInOrganization } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');

  return { authClient: authClientStub };
});

const getContentProject = vi.fn();

vi.mock('../organization-api', async () => {
  const actual = await vi.importActual<typeof import('../organization-api')>(
    '../organization-api',
  );

  return {
    ...actual,
    getContentProject: (...args: unknown[]) => getContentProject(...args),
  };
});

const { OrganizationContentProjectBlock } =
  await import('./organization-content-project-block');
const { ApiError } = await import('@/lib/application-api');

const detail = (overrides: Record<string, unknown> = {}) => ({
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
  brief: {
    topic: 'Electric kettles',
    goal: 'Sell the autumn range',
    audience: 'Home cooks',
    guidance: 'Warm and practical.',
  },
  createdByUserId: 'user_1',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  drafts: [
    {
      id: 'draft_1',
      revision: 1,
      title: 'Kettle teardown',
      format: 'video',
      language: 'en',
      body: null,
      createdAt: '2026-02-01T00:00:00.000Z',
    },
  ],
  ...overrides,
});

const render = () =>
  renderInOrganization(
    <OrganizationContentProjectBlock projectId="proj_1" />,
    context({ organization: organization() }),
  );

describe('organization content project block', () => {
  beforeEach(() => {
    resetAuthClientStub();
    authClientStub.organization.checkRolePermission.mockReturnValue(true);
    getContentProject.mockReset();
  });

  it('shows the stored idea beside its first draft', async () => {
    getContentProject.mockResolvedValue(detail());

    render();

    expect(await screen.findAllByText('Kettle teardown')).toHaveLength(2);
    expect(
      screen.getByText('Cost breakdown as a trust signal'),
    ).toBeInTheDocument();
    expect(screen.getByText(/revision 1/i)).toBeInTheDocument();
  });

  it('says the draft is unwritten rather than showing nothing', async () => {
    getContentProject.mockResolvedValue(detail());

    render();

    expect(
      await screen.findByText(/nothing has been written yet/i),
    ).toBeInTheDocument();
  });

  it('renders the body once something has written it', async () => {
    getContentProject.mockResolvedValue(
      detail({
        drafts: [
          {
            id: 'draft_1',
            revision: 1,
            title: 'Kettle teardown',
            format: 'video',
            language: 'en',
            body: 'The element is the whole story.',
            createdAt: '2026-02-01T00:00:00.000Z',
          },
        ],
      }),
    );

    render();

    expect(
      await screen.findByText('The element is the whole story.'),
    ).toBeInTheDocument();
  });

  it('shows the brief the ideas were generated from', async () => {
    getContentProject.mockResolvedValue(detail());

    render();

    const valueFor = (label: string) =>
      screen.getByText(label).parentElement?.textContent ?? '';

    await screen.findByText('Electric kettles');

    expect(valueFor('Topic:')).toContain('Electric kettles');
    expect(valueFor('Goal:')).toContain('Sell the autumn range');
    expect(valueFor('Audience:')).toContain('Home cooks');
    expect(valueFor('Guidance:')).toContain('Warm and practical.');
  });

  it('omits an optional field the request left empty', async () => {
    getContentProject.mockResolvedValue(
      detail({
        brief: {
          topic: 'Electric kettles',
          goal: 'Sell the autumn range',
          audience: '',
          guidance: '',
        },
      }),
    );

    render();

    expect(await screen.findByText('Electric kettles')).toBeInTheDocument();
    expect(screen.queryByText(/^audience:$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^guidance:$/i)).not.toBeInTheDocument();
  });

  it('omits the optional rows the original request left out', async () => {
    getContentProject.mockResolvedValue(
      detail({
        brief: {
          topic: 'Electric kettles',
          goal: 'Sell the autumn range',
          audience: null,
          guidance: null,
        },
      }),
    );

    render();

    expect(await screen.findByText('Electric kettles')).toBeInTheDocument();
    expect(screen.queryByText(/^audience:$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^guidance:$/i)).not.toBeInTheDocument();
  });

  it('renders in Arabic without falling back to the default locale', async () => {
    getContentProject.mockResolvedValue(detail());

    renderInOrganization(
      <OrganizationContentProjectBlock projectId="proj_1" />,
      context({ organization: organization() }),
      { locale: 'ar' },
    );

    expect(await screen.findByText('الفكرة')).toBeInTheDocument();
    expect(screen.getByText(/لم يُكتب شيء بعد/)).toBeInTheDocument();
  });

  it('reports a refused project as simply absent', async () => {
    getContentProject.mockRejectedValue(new ApiError(404, 'NOT_FOUND'));

    render();

    expect(
      await screen.findByText(/this project does not exist/i),
    ).toBeInTheDocument();
  });
});
