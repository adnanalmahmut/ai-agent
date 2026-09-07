import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationProvider } from '@/features/organization/organization-context';

import {
  allowOrganizationPermissions as allow,
  authClientStub,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import {
  currentUrl,
  pushSpy,
  replaceSpy,
  stubLocation,
} from '@/test/navigation-stub';
import { context, organization } from '@/test/organization-fixtures';
import { renderInOrganization } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');

  return { authClient: authClientStub };
});

const requestContentIdeas = vi.fn();
const getContentIdeaOperation = vi.fn();
const getContentIdeaAvailability = vi.fn();
const createContentProjectFromIdea = vi.fn();

vi.mock('../organization-api', async () => {
  const actual = await vi.importActual<typeof import('../organization-api')>(
    '../organization-api',
  );

  return {
    ...actual,
    requestContentIdeas: (...args: unknown[]) => requestContentIdeas(...args),
    getContentIdeaOperation: (...args: unknown[]) =>
      getContentIdeaOperation(...args),
    getContentIdeaAvailability: (...args: unknown[]) =>
      getContentIdeaAvailability(...args),
    createContentProjectFromIdea: (...args: unknown[]) =>
      createContentProjectFromIdea(...args),
  };
});

const { OrganizationContentIdeasBlock } =
  await import('./organization-content-ideas-block');
const { ApiError, ApiUnavailableError } = await import('@/lib/application-api');

const operation = (overrides: Record<string, unknown> = {}) => ({
  id: 'op_1',
  status: 'QUEUED',
  output: null,
  createdAt: '2026-02-01T00:00:00.000Z',
  completedAt: null,
  ...overrides,
});

const succeeded = (
  ideas: unknown[],
  sources: string[] = [],
  overrides: Record<string, unknown> = {},
) =>
  operation({
    status: 'SUCCEEDED',
    output: { ideas, sources },
    completedAt: '2026-02-01T00:00:10.000Z',
    ...overrides,
  });

const after = <T,>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

/** A request that answers when the test says so, and never before. */
const deferred = <T,>() => {
  let settle!: (value: T) => void;
  let refuse!: (reason: unknown) => void;

  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    refuse = reject;
  });

  return { promise, settle, refuse };
};

const IDEA = {
  title: 'Why our kettle boils in ninety seconds',
  hook: 'Ninety seconds. Not a marketing number — a physics one.',
  angle: 'Lead with the engineering, then the morning routine.',
  summary:
    'Open on the element, explain why surface area beats wattage, and land on what that buys somebody at 7am.',
  suggestedFormat: 'post',
};

const POLL_MS = 10;

const render = (
  props: { pollTimeoutMs?: number } = {},
  options: { initialEntries?: string[] } = {},
) =>
  renderInOrganization(
    <OrganizationContentIdeasBlock pollIntervalMs={POLL_MS} {...props} />,
    context({ organization: organization() }),
    options,
  );

const fillForm = async () => {
  await userEvent.type(screen.getByLabelText(/^topic$/i), 'Electric kettles');
  await userEvent.type(
    screen.getByLabelText(/^goal$/i),
    'Sell the autumn range',
  );
};

const REQUEST = {
  topic: 'Electric kettles',
  goal: 'Sell the autumn range',
  language: 'en',
  numberOfIdeas: 5,
};

const submit = () =>
  userEvent.click(screen.getByRole('button', { name: /generate ideas/i }));

const settle = () => new Promise((resolve) => setTimeout(resolve, POLL_MS * 6));

const OTHER_ORGANIZATION = 'org_elsewhere';

/**
 * The organization is context, not a prop, so a test that needs it to change
 * has to change it where the screen reads it. The button is the test's own
 * handle on that, standing in for the switcher the shell renders.
 */
function InOrganization({ pollTimeoutMs }: { pollTimeoutMs?: number }) {
  const [organizationId, setOrganizationId] = useState(organization().id);

  return (
    <>
      <button onClick={() => setOrganizationId(OTHER_ORGANIZATION)}>
        switch organization
      </button>
      <OrganizationProvider
        value={context({ organization: organization({ id: organizationId }) })}
      >
        <OrganizationContentIdeasBlock
          pollIntervalMs={POLL_MS}
          pollTimeoutMs={pollTimeoutMs}
        />
      </OrganizationProvider>
    </>
  );
}

const renderSwitchable = (
  props: { pollTimeoutMs?: number } = {},
  options: { initialEntries?: string[] } = {},
) =>
  renderInOrganization(
    <InOrganization {...props} />,
    context({ organization: organization() }),
    options,
  );

const switchOrganization = () =>
  userEvent.click(screen.getByRole('button', { name: /switch organization/i }));

beforeEach(() => {
  resetAuthClientStub();
  vi.clearAllMocks();
  requestContentIdeas.mockResolvedValue(operation());
  getContentIdeaOperation.mockResolvedValue(operation());
  getContentIdeaAvailability.mockResolvedValue({
    available: true,
    reason: null,
  });
  window.sessionStorage.clear();
});

describe('the content ideas screen', () => {
  it('asks for the organization in hand, not the active one', async () => {
    allow('contentIdea:create', 'contentIdea:read');
    authClientStub.useActiveOrganization.mockReturnValue({
      data: { id: 'org_elsewhere', name: 'Elsewhere' },
      isPending: false,
    });

    render();
    await fillForm();
    await submit();

    await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

    expect(requestContentIdeas).toHaveBeenCalledWith(
      organization().id,
      expect.anything(),
      expect.any(String),
    );
    expect(requestContentIdeas).not.toHaveBeenCalledWith(
      'org_elsewhere',
      expect.anything(),
      expect.any(String),
    );
  });

  it('sends the trimmed request and omits what was left blank', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await userEvent.type(
      screen.getByLabelText(/^topic$/i),
      '  Electric kettles  ',
    );
    await userEvent.type(
      screen.getByLabelText(/^goal$/i),
      '  Sell the autumn range  ',
    );
    await submit();

    await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

    expect(requestContentIdeas.mock.calls[0]?.[1]).toEqual(REQUEST);
  });

  it('sends the optional fields when they were given, trimmed like the rest', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await fillForm();
    await userEvent.type(screen.getByLabelText(/^audience/i), '  Home cooks  ');
    await userEvent.type(
      screen.getByLabelText(/guidance/i),
      '  Keep it playful.  ',
    );
    await submit();

    await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

    expect(requestContentIdeas.mock.calls[0]?.[1]).toEqual({
      ...REQUEST,
      audience: 'Home cooks',
      guidance: 'Keep it playful.',
    });
  });

  it('sends the language that was chosen, not the one being read', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await fillForm();
    await userEvent.selectOptions(
      screen.getByLabelText(/content language/i),
      'ar',
    );
    await submit();

    await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

    expect(requestContentIdeas.mock.calls[0]?.[1]).toMatchObject({
      language: 'ar',
    });
  });

  it('does not take the content language from the interface locale', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    renderInOrganization(
      <OrganizationContentIdeasBlock pollIntervalMs={POLL_MS} />,
      context({ organization: organization() }),
      { locale: 'ar' },
    );

    await userEvent.type(screen.getByLabelText(/الموضوع/), 'أباريق كهربائية');
    await userEvent.type(screen.getByLabelText(/الهدف/), 'بيع تشكيلة الخريف');
    await userEvent.click(screen.getByRole('button', { name: /ولّد أفكاراً/ }));

    await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

    expect(requestContentIdeas.mock.calls[0]?.[1]).toMatchObject({
      language: 'en',
    });
  });

  it('sends the number of ideas under its contract name', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await fillForm();
    await userEvent.clear(screen.getByLabelText(/how many/i));
    await userEvent.type(screen.getByLabelText(/how many/i), '7');
    await submit();

    await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

    const sent = requestContentIdeas.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;

    expect(sent.numberOfIdeas).toBe(7);
    expect(sent).not.toHaveProperty('count');
  });

  it('will not submit a request the schema would refuse', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await userEvent.type(screen.getByLabelText(/^topic$/i), 'a');
    await userEvent.type(screen.getByLabelText(/^goal$/i), 'a');

    expect(
      screen.getByRole('button', { name: /generate ideas/i }),
    ).toBeDisabled();
  });

  it('will not submit without a goal', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await userEvent.type(screen.getByLabelText(/^topic$/i), 'Electric kettles');

    expect(
      screen.getByRole('button', { name: /generate ideas/i }),
    ).toBeDisabled();
  });

  it('will not submit a one-character audience, but will submit none at all', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await fillForm();

    expect(
      screen.getByRole('button', { name: /generate ideas/i }),
    ).toBeEnabled();

    await userEvent.type(screen.getByLabelText(/^audience/i), 'a');

    expect(
      screen.getByRole('button', { name: /generate ideas/i }),
    ).toBeDisabled();
  });

  it.each([
    ['emptied', ''],
    ['zero', '0'],
    ['beyond what the contract allows', '50'],
  ])('will not submit a count that is %s', async (_name, typed) => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await fillForm();
    await userEvent.clear(screen.getByLabelText(/how many/i));
    if (typed !== '') {
      await userEvent.type(screen.getByLabelText(/how many/i), typed);
    }

    expect(
      screen.getByRole('button', { name: /generate ideas/i }),
    ).toBeDisabled();
  });

  describe('the schema bounds it enforces itself', () => {
    it.each([
      ['topic', /^topic$/i, 200],
      ['goal', /^goal$/i, 300],
      ['audience', /^audience/i, 200],
      ['guidance', /guidance/i, 1_000],
    ])('caps %s at the length the schema allows', (_name, label, most) => {
      allow('contentIdea:create', 'contentIdea:read');

      render();

      expect(screen.getByLabelText(label)).toHaveAttribute(
        'maxlength',
        String(most),
      );
    });

    it.each([
      ['topic', /^topic$/i, 201],
      ['goal', /^goal$/i, 301],
      ['audience', /^audience/i, 201],
      ['guidance', /guidance/i, 1_001],
    ])('will not submit an over-long %s', async (_name, label, length) => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();

      fireEvent.change(screen.getByLabelText(label), {
        target: { value: 'a'.repeat(length) },
      });

      expect(
        screen.getByRole('button', { name: /generate ideas/i }),
      ).toBeDisabled();
    });
  });

  describe('the idempotency key', () => {
    it('is sent with the request', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

      expect(requestContentIdeas.mock.calls[0]?.[2]).toEqual(
        expect.stringMatching(/\S{8,}/),
      );
    });

    it('is reused when the request never reached the server', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(new ApiUnavailableError());

      render();
      await fillForm();
      await submit();
      expect(await screen.findByText(/could not be reached/i)).toBeVisible();

      requestContentIdeas.mockResolvedValue(operation());
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalledTimes(2));

      expect(requestContentIdeas.mock.calls[1]?.[2]).toBe(
        requestContentIdeas.mock.calls[0]?.[2],
      );
    });

    it('is reused when the server failed rather than refused', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(new ApiError(504, undefined));

      render();
      await fillForm();
      await submit();
      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

      requestContentIdeas.mockResolvedValue(operation());
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalledTimes(2));

      expect(requestContentIdeas.mock.calls[1]?.[2]).toBe(
        requestContentIdeas.mock.calls[0]?.[2],
      );
    });

    it('is replaced after the server refused', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(
        new ApiError(400, 'VALIDATION_ERROR'),
      );

      render();
      await fillForm();
      await submit();
      expect(await screen.findByText(/could not be accepted/i)).toBeVisible();

      requestContentIdeas.mockResolvedValue(operation());
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalledTimes(2));

      expect(requestContentIdeas.mock.calls[1]?.[2]).not.toBe(
        requestContentIdeas.mock.calls[0]?.[2],
      );
    });

    it('is new for a second, different ask', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

      getContentIdeaOperation.mockResolvedValue(succeeded([IDEA]));
      expect(await screen.findByText(IDEA.title)).toBeVisible();

      await userEvent.clear(screen.getByLabelText(/^topic$/i));
      await userEvent.type(screen.getByLabelText(/^topic$/i), 'Cast iron pans');
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalledTimes(2));

      expect(requestContentIdeas.mock.calls[1]?.[2]).not.toBe(
        requestContentIdeas.mock.calls[0]?.[2],
      );
    });
  });

  it('will not take a second request while one is in flight', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await fillForm();
    await submit();

    expect(await screen.findByText(/^queued$/i)).toBeVisible();

    const button = screen.getByRole('button', { name: /generate ideas/i });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText(/^topic$/i)).toBeDisabled();

    await userEvent.click(button);

    expect(requestContentIdeas).toHaveBeenCalledTimes(1);
  });

  describe('polling', () => {
    it('defaults to a cadence that does not hammer the endpoint', () => {
      allow('contentIdea:create', 'contentIdea:read');

      renderInOrganization(
        <OrganizationContentIdeasBlock />,
        context({ organization: organization() }),
      );

      expect(getContentIdeaOperation).not.toHaveBeenCalled();
    });

    it('shows the run queued, then running, then its ideas', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();
      expect(await screen.findByText(/^queued$/i)).toBeVisible();
      expect(screen.queryByText(IDEA.title)).not.toBeInTheDocument();

      getContentIdeaOperation.mockResolvedValue(
        operation({ status: 'RUNNING' }),
      );
      expect(await screen.findByText(/^running$/i)).toBeVisible();

      getContentIdeaOperation.mockResolvedValue(
        succeeded([IDEA], ['brand.voice']),
      );
      expect(await screen.findByText(IDEA.title)).toBeVisible();

      expect(screen.getByText(IDEA.hook)).toBeVisible();
      expect(screen.getByText(IDEA.angle, { exact: false })).toBeVisible();
      expect(screen.getByText(IDEA.summary)).toBeVisible();
      expect(screen.getByText('Post')).toBeVisible();
      expect(screen.getByText(/grounded in: brand\.voice/i)).toBeVisible();
    });

    it('polls the operation it was given, for this organization', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();

      await waitFor(() => expect(getContentIdeaOperation).toHaveBeenCalled());

      expect(getContentIdeaOperation).toHaveBeenCalledWith(
        organization().id,
        'op_1',
        expect.any(AbortSignal),
      );
    });

    it('stops once the run reaches a terminal status', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaOperation.mockResolvedValue(succeeded([IDEA]));

      render();
      await fillForm();
      await submit();

      expect(await screen.findByText(IDEA.title)).toBeVisible();

      const settled = getContentIdeaOperation.mock.calls.length;

      await settle();

      expect(getContentIdeaOperation).toHaveBeenCalledTimes(settled);
    });

    it('says the run failed and offers no result', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();

      getContentIdeaOperation.mockResolvedValue(
        operation({
          status: 'FAILED',
          completedAt: '2026-02-01T00:00:20.000Z',
        }),
      );

      expect(await screen.findByText(/could not complete/i)).toBeVisible();
      expect(screen.queryByText(IDEA.title)).not.toBeInTheDocument();
    });

    it('says so when a finished run carried no ideas', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();

      getContentIdeaOperation.mockResolvedValue(succeeded([]));

      expect(await screen.findByText(/returned no ideas/i)).toBeVisible();
    });

    it('says an answer was not grounded in anything stored', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();

      getContentIdeaOperation.mockResolvedValue(succeeded([IDEA], []));

      expect(await screen.findByText(IDEA.title)).toBeVisible();
      expect(screen.getByText(/not grounded/i)).toBeVisible();
    });

    it('rides out a poll that could not reach the server', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();

      getContentIdeaOperation.mockRejectedValueOnce(new ApiUnavailableError());
      getContentIdeaOperation.mockResolvedValue(succeeded([IDEA]));

      expect(await screen.findByText(IDEA.title)).toBeVisible();
      expect(
        screen.queryByText(/could not be reached/i),
      ).not.toBeInTheDocument();
    });

    it('keeps watching through a rate limit and a broken server', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();
      await waitFor(() => expect(getContentIdeaOperation).toHaveBeenCalled());

      getContentIdeaOperation.mockRejectedValueOnce(
        new ApiError(429, 'TOO_MANY_REQUESTS'),
      );
      getContentIdeaOperation.mockRejectedValueOnce(
        new ApiError(503, 'SERVICE_UNAVAILABLE'),
      );
      getContentIdeaOperation.mockResolvedValue(succeeded([IDEA]));

      expect(await screen.findByText(IDEA.title)).toBeVisible();
      expect(screen.queryByText(/too many requests/i)).not.toBeInTheDocument();
    });

    it('never puts a finished run back to pending', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      getContentIdeaOperation
        .mockImplementationOnce(() => after(POLL_MS * 8, operation()))
        .mockImplementation(() => Promise.resolve(succeeded([IDEA])));

      render();
      await fillForm();
      await submit();

      expect(await screen.findByText(IDEA.title)).toBeVisible();

      await settle();
      await settle();

      expect(screen.getByText(IDEA.title)).toBeVisible();
      expect(screen.queryByText(/^queued$/i)).not.toBeInTheDocument();
    });

    it('gives up and reports a poll the server refused', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();

      getContentIdeaOperation.mockRejectedValue(new ApiError(404, 'NOT_FOUND'));

      expect(await screen.findByText(/could not be found/i)).toBeVisible();

      const settled = getContentIdeaOperation.mock.calls.length;
      await settle();

      expect(getContentIdeaOperation).toHaveBeenCalledTimes(settled);
    });
  });

  describe('the organization the run belongs to', () => {
    it('reads the run named by the address against the organization in hand', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaOperation.mockResolvedValue(
        operation({ id: 'op_1', status: 'RUNNING' }),
      );

      renderSwitchable({}, { initialEntries: ['/?operation=op_1'] });

      expect(await screen.findByText('Running')).toBeVisible();
      expect(getContentIdeaOperation).toHaveBeenCalledWith(
        organization().id,
        'op_1',
        expect.anything(),
      );

      await switchOrganization();

      await waitFor(() =>
        expect(getContentIdeaOperation).toHaveBeenCalledWith(
          OTHER_ORGANIZATION,
          'op_1',
          expect.anything(),
        ),
      );
    });

    it('shows nothing from the organization the reader has left', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaOperation.mockImplementation((organizationId: string) =>
        organizationId === organization().id
          ? Promise.resolve(succeeded([IDEA], [], { id: 'op_1' }))
          : new Promise(() => undefined),
      );

      renderSwitchable({}, { initialEntries: ['/?operation=op_1'] });

      expect(await screen.findByText(IDEA.title)).toBeVisible();

      await switchOrganization();

      // The run belongs to the organization it was read for. Until the one in
      // hand answers for itself, this screen has nothing to show.
      expect(await screen.findByText(/no ideas requested yet/i)).toBeVisible();
      expect(screen.queryByText(IDEA.title)).not.toBeInTheDocument();
    });

    it('asks the organization in hand about availability', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      renderSwitchable();

      await waitFor(() =>
        expect(getContentIdeaAvailability).toHaveBeenCalledWith(
          organization().id,
          expect.anything(),
        ),
      );

      await switchOrganization();

      await waitFor(() =>
        expect(getContentIdeaAvailability).toHaveBeenCalledWith(
          OTHER_ORGANIZATION,
          expect.anything(),
        ),
      );
    });
  });

  describe('a read the screen no longer needs', () => {
    const hanging = () => {
      const signals: AbortSignal[] = [];

      getContentIdeaOperation.mockImplementation(
        (_organizationId: string, _id: string, signal: AbortSignal) => {
          signals.push(signal);

          return new Promise(() => undefined);
        },
      );

      return signals;
    };

    it('is abandoned through the signal when the screen goes away', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      const signals = hanging();

      const view = render({}, { initialEntries: ['/?operation=op_1'] });

      await waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0]?.aborted).toBe(false);

      view.unmount();

      await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    });

    it('is abandoned when the reader moves to another organization', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      const signals = hanging();

      renderSwitchable({}, { initialEntries: ['/?operation=op_1'] });

      await waitFor(() => expect(signals).toHaveLength(1));

      await switchOrganization();

      await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    });

    it('is abandoned when the address moves to another run', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      const signals = hanging();

      render({}, { initialEntries: ['/?operation=op_first'] });

      await waitFor(() => expect(signals).toHaveLength(1));

      act(() => stubLocation('/?operation=op_second'));

      await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    });
  });

  describe('a read that lands late', () => {
    it('does not show a run the reader has already moved on from', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      getContentIdeaOperation.mockImplementation((_org: string, id: string) =>
        id === 'op_slow'
          ? after(POLL_MS * 12, operation({ id: 'op_slow', status: 'RUNNING' }))
          : Promise.resolve(succeeded([IDEA], [], { id })),
      );

      render({}, { initialEntries: ['/?operation=op_slow'] });

      await waitFor(() => expect(getContentIdeaOperation).toHaveBeenCalled());

      act(() => stubLocation('/?operation=op_done'));

      expect(await screen.findByText(IDEA.title)).toBeVisible();

      await settle();
      await settle();

      expect(screen.getByText(IDEA.title)).toBeVisible();
      expect(screen.queryByText(/^running$/i)).not.toBeInTheDocument();
    });

    it('does not put a finished run back to pending', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      // The first read is still on its way, and still says queued, when the
      // reader gives up on it and asks again. The answer it eventually brings
      // back is older than the one already on the screen.
      getContentIdeaOperation
        .mockImplementationOnce(() => after(POLL_MS * 15, operation()))
        .mockImplementation(() => Promise.resolve(succeeded([IDEA])));

      render({ pollTimeoutMs: 0 });
      await fillForm();
      await submit();

      await screen.findByText(/taking longer than expected/i);
      await userEvent.click(
        screen.getByRole('button', { name: /keep waiting/i }),
      );

      expect(await screen.findByText(IDEA.title)).toBeVisible();

      await settle();
      await settle();
      await settle();

      expect(screen.getByText(IDEA.title)).toBeVisible();
      expect(screen.queryByText(/^queued$/i)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/taking longer than expected/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('a cancelled read that answers anyway', () => {
    /**
     * Query drops the *result* of a read it has abandoned, and that is all it
     * can do: a request that never looks at the signal, or one that settles
     * inside the race with its own cancellation, still runs the rest of the
     * query function. What that code says about failures, about giving up,
     * and about the address has to be its own business to hold back.
     */
    it('does not refuse on behalf of the run the reader moved to', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      const stale = deferred<unknown>();
      const signals: AbortSignal[] = [];

      getContentIdeaOperation.mockImplementation(
        (_organizationId: string, id: string, signal: AbortSignal) => {
          if (id !== 'op_stale') {
            return Promise.resolve(operation({ id, status: 'RUNNING' }));
          }

          signals.push(signal);

          return stale.promise;
        },
      );

      render({}, { initialEntries: ['/?operation=op_stale'] });

      await waitFor(() => expect(signals).toHaveLength(1));

      act(() => stubLocation('/?operation=op_current'));

      expect(await screen.findByText('Running')).toBeVisible();
      await waitFor(() => expect(signals[0]?.aborted).toBe(true));

      await act(async () => {
        stale.refuse(new ApiError(404, 'NOT_FOUND'));
        await Promise.resolve();
      });

      await settle();

      expect(screen.queryByText(/could not be found/i)).not.toBeInTheDocument();
      expect(currentUrl()).toContain('operation=op_current');
      expect(screen.getByText('Running')).toBeVisible();
    });

    it('does not clear a refusal the reader is being shown', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      const stale = deferred<unknown>();
      const signals: AbortSignal[] = [];

      getContentIdeaOperation.mockImplementation(
        (organizationId: string, _id: string, signal: AbortSignal) => {
          if (organizationId !== organization().id) {
            return Promise.reject(new ApiError(404, 'NOT_FOUND'));
          }

          signals.push(signal);

          return stale.promise;
        },
      );

      renderSwitchable({}, { initialEntries: ['/?operation=op_1'] });

      await waitFor(() => expect(signals).toHaveLength(1));

      await switchOrganization();

      expect(await screen.findByText(/could not be found/i)).toBeVisible();
      await waitFor(() => expect(signals[0]?.aborted).toBe(true));

      await act(async () => {
        stale.settle(succeeded([IDEA], [], { id: 'op_1' }));
        await Promise.resolve();
      });

      await settle();

      expect(screen.getByText(/could not be found/i)).toBeVisible();
      expect(screen.queryByText(IDEA.title)).not.toBeInTheDocument();
    });

    it('does not put the screen back to watching a refused run', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      const stale = deferred<unknown>();
      const signals: AbortSignal[] = [];
      let current = () =>
        Promise.resolve(operation({ id: 'op_current', status: 'RUNNING' }));

      getContentIdeaOperation.mockImplementation(
        (_organizationId: string, id: string, signal: AbortSignal) => {
          if (id !== 'op_stale') return current();

          signals.push(signal);

          return stale.promise;
        },
      );

      render({}, { initialEntries: ['/?operation=op_stale'] });

      await waitFor(() => expect(signals).toHaveLength(1));

      act(() => stubLocation('/?operation=op_current'));

      expect(await screen.findByText('Running')).toBeVisible();

      current = () => Promise.reject(new ApiError(404, 'NOT_FOUND'));

      expect(await screen.findByText(/could not be found/i)).toBeVisible();

      const asked = getContentIdeaOperation.mock.calls.length;

      await act(async () => {
        stale.settle(succeeded([IDEA], [], { id: 'op_stale' }));
        await Promise.resolve();
      });

      await settle();

      // A run the reader left cannot start the watch up again on a run the
      // server has already refused.
      expect(getContentIdeaOperation).toHaveBeenCalledTimes(asked);
      expect(screen.getByText(/could not be found/i)).toBeVisible();
    });
  });

  describe('waiting too long', () => {
    it('reports the run as still running, not as whatever it last saw', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render({ pollTimeoutMs: 0 });
      await fillForm();
      await submit();

      expect(
        await screen.findByText(/taking longer than expected/i),
      ).toBeVisible();
      expect(screen.getByText(/^still running$/i)).toBeVisible();
      expect(screen.queryByText(/^queued$/i)).not.toBeInTheDocument();
    });

    it('stops asking once it has given up', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render({ pollTimeoutMs: 0 });
      await fillForm();
      await submit();

      await screen.findByText(/taking longer than expected/i);

      const settled = getContentIdeaOperation.mock.calls.length;
      await settle();

      expect(getContentIdeaOperation).toHaveBeenCalledTimes(settled);
    });

    it('picks the run back up when asked to keep waiting', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render({ pollTimeoutMs: 0 });
      await fillForm();
      await submit();

      await screen.findByText(/taking longer than expected/i);

      getContentIdeaOperation.mockResolvedValue(succeeded([IDEA]));
      await userEvent.click(
        screen.getByRole('button', { name: /keep waiting/i }),
      );

      expect(await screen.findByText(IDEA.title)).toBeVisible();
    });

    it('offers no resume when the server refused instead', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();
      await waitFor(() => expect(getContentIdeaOperation).toHaveBeenCalled());

      getContentIdeaOperation.mockRejectedValue(new ApiError(404, 'NOT_FOUND'));

      expect(await screen.findByText(/could not be found/i)).toBeVisible();
      expect(
        screen.queryByRole('button', { name: /keep waiting/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/taking longer than expected/i),
      ).not.toBeInTheDocument();
    });
  });

  it('watches the new run even after the last one was refused', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    getContentIdeaOperation.mockImplementation((_org: string, id: string) =>
      id === 'op_1'
        ? Promise.reject(new ApiError(404, 'NOT_FOUND'))
        : Promise.resolve(succeeded([IDEA], [], { id })),
    );

    render();
    await fillForm();
    await submit();

    expect(await screen.findByText(/could not be found/i)).toBeVisible();

    requestContentIdeas.mockResolvedValue(operation({ id: 'op_2' }));
    await submit();

    expect(await screen.findByText(IDEA.title)).toBeVisible();
    expect(screen.queryByText(/could not be found/i)).not.toBeInTheDocument();
  });

  describe('refusals', () => {
    it('says the feature is off rather than blaming permissions', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValue(
        new ApiError(403, 'FEATURE_DISABLED'),
      );

      render();
      await fillForm();
      await submit();
      expect(await screen.findByText(/switched off/i)).toBeVisible();
      expect(
        screen.queryByText(/do not have permission/i),
      ).not.toBeInTheDocument();
    });

    it('still blames permissions for an ordinary refusal', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValue(new ApiError(403, 'FORBIDDEN'));

      render();
      await fillForm();
      await submit();
      expect(await screen.findByText(/do not have permission/i)).toBeVisible();
      expect(screen.queryByText(/switched off/i)).not.toBeInTheDocument();
    });

    it('renders the reason a 429 carried', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValue(
        new ApiError(429, 'TOO_MANY_REQUESTS', {
          kind: 'business',
          reason:
            'This organization already has the maximum number of agent runs in flight. Wait for one to finish.',
        }),
      );

      render();
      await fillForm();
      await submit();
      expect(await screen.findByText(/too many requests/i)).toBeVisible();
      expect(
        screen.getByText(/maximum number of agent runs in flight/i),
      ).toBeVisible();
    });

    it('says only that a refused body was refused', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValue(
        new ApiError(400, 'VALIDATION_ERROR', { kind: 'none' }),
      );

      render();
      await fillForm();
      await submit();

      expect(await screen.findByText(/could not be accepted/i)).toBeVisible();
    });
  });

  describe('recovering an operation from the URL', () => {
    it('puts an accepted operation into the address', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockResolvedValue(operation({ id: 'op_accepted' }));

      render();
      await fillForm();
      await submit();

      await waitFor(() =>
        expect(currentUrl()).toContain('operation=op_accepted'),
      );
    });

    it('replaces rather than pushes, so the back button leaves the screen', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();

      await fillForm();
      await submit();

      await waitFor(() => expect(currentUrl()).toContain('operation=op_1'));

      expect(replaceSpy).toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('picks up the run named by the address on arrival', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaOperation.mockResolvedValue(
        operation({ id: 'op_reloaded', status: 'RUNNING' }),
      );

      render({}, { initialEntries: ['/?operation=op_reloaded'] });

      expect(await screen.findByText('Running')).toBeVisible();
      expect(getContentIdeaOperation).toHaveBeenCalledWith(
        organization().id,
        'op_reloaded',
        expect.anything(),
      );
      expect(requestContentIdeas).not.toHaveBeenCalled();
    });

    it('follows the address when only the query changes', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaOperation.mockResolvedValue(
        operation({ id: 'op_from_the_address', status: 'RUNNING' }),
      );

      render({}, { initialEntries: ['/'] });

      expect(await screen.findByText(/no ideas requested yet/i)).toBeVisible();

      // The reader stays on the same page; only the query moves. Reading the
      // address once at mount would leave the screen showing the old answer.
      act(() => stubLocation('/?operation=op_from_the_address'));

      expect(await screen.findByText('Running')).toBeVisible();
      expect(getContentIdeaOperation).toHaveBeenCalledWith(
        organization().id,
        'op_from_the_address',
        expect.anything(),
      );
    });

    it('recovers a finished result, not only a running one', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaOperation.mockResolvedValue(
        succeeded([IDEA], ['brand.voice'], { id: 'op_done' }),
      );

      render({}, { initialEntries: ['/?operation=op_done'] });

      expect(await screen.findByText(IDEA.title)).toBeVisible();
      expect(screen.getByText(IDEA.summary)).toBeVisible();
    });

    it('shows nothing and clears the address for an operation it cannot read', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaOperation.mockRejectedValue(new ApiError(404, 'NOT_FOUND'));

      render({}, { initialEntries: ['/?operation=op_from_another_org'] });

      expect(
        await screen.findByText(/that request could not be found/i),
      ).toBeVisible();
      await waitFor(() =>
        expect(currentUrl()).not.toContain('op_from_another_org'),
      );
      expect(screen.getByText(/no ideas requested yet/i)).toBeVisible();
    });

    it('keeps the address through a server failure', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaOperation.mockRejectedValue(new ApiError(500, 'INTERNAL'));

      render({}, { initialEntries: ['/?operation=op_kept'] });

      await settle();

      expect(currentUrl()).toContain('operation=op_kept');
    });
  });

  describe('the idempotency key across a reload', () => {
    const keyOf = (call: number) =>
      requestContentIdeas.mock.calls[call]?.[2] as string;

    it('reuses the stored key for the same request after a reload', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(
        new ApiError(502, 'BAD_GATEWAY'),
      );

      const first = render();
      await fillForm();
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalledTimes(1));

      first.unmount();
      vi.clearAllMocks();
      requestContentIdeas.mockResolvedValue(operation());
      getContentIdeaAvailability.mockResolvedValue({
        available: true,
        reason: null,
      });

      render();
      await fillForm();
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalledTimes(1));

      expect(
        JSON.parse(
          window.sessionStorage.getItem(
            `content-idea:pending:${organization().id}`,
          ) ?? 'null',
        ),
      ).toBeNull();
    });

    it('does not reuse the stored key for a materially different request', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(
        new ApiError(502, 'BAD_GATEWAY'),
      );

      const first = render();
      await fillForm();
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalledTimes(1));

      const abandoned = keyOf(0);

      first.unmount();
      requestContentIdeas.mockReset();
      requestContentIdeas.mockResolvedValue(operation());

      render();
      await userEvent.type(screen.getByLabelText(/^topic$/i), 'Cast iron pans');
      await userEvent.type(
        screen.getByLabelText(/^goal$/i),
        'Sell the autumn range',
      );
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

      expect(keyOf(0)).not.toBe(abandoned);
    });

    it('forgets the key once the server has refused', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(
        new ApiError(400, 'VALIDATION_ERROR'),
      );

      render();
      await fillForm();
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

      expect(
        window.sessionStorage.getItem(
          `content-idea:pending:${organization().id}`,
        ),
      ).toBeNull();
    });

    it('stores only an opaque digest of the request, never its text', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(
        new ApiError(502, 'BAD_GATEWAY'),
      );

      render();
      await userEvent.type(
        screen.getByLabelText(/^topic$/i),
        'Project Nightjar',
      );
      await userEvent.type(
        screen.getByLabelText(/^goal$/i),
        'Warm the list before launch',
      );
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

      const raw = window.sessionStorage.getItem(
        `content-idea:pending:${organization().id}`,
      );

      expect(raw).not.toBeNull();

      const stored = JSON.parse(raw ?? 'null') as Record<string, unknown>;

      expect(Object.keys(stored).sort()).toEqual([
        'idempotencyKey',
        'requestDigest',
      ]);
      expect(stored.idempotencyKey).toBe(keyOf(0));
      expect(stored.requestDigest).toMatch(/^[0-9a-f]{64}$/);

      const dump = Object.entries({ ...window.sessionStorage })
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('\n');

      expect(dump).not.toContain('Project Nightjar');
      expect(dump).not.toContain('Warm the list before launch');
    });

    it('reports a failure when the request digest cannot be computed', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      const digest = vi
        .spyOn(crypto.subtle, 'digest')
        .mockRejectedValue(new Error('SubtleCrypto is unavailable'));

      try {
        render();
        await fillForm();
        await submit();

        expect(await screen.findByText(/something went wrong/i)).toBeVisible();
        expect(requestContentIdeas).not.toHaveBeenCalled();
        expect(
          screen.getByRole('button', { name: /generate ideas/i }),
        ).toBeEnabled();
      } finally {
        digest.mockRestore();
      }
    });

    it('still submits when the browser refuses to store the key', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      const setItem = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new Error('storage is blocked');
        });

      try {
        render();
        await fillForm();
        await submit();

        await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());
        expect(keyOf(0)).toEqual(expect.any(String));
      } finally {
        setItem.mockRestore();
      }
    });
  });

  describe('availability', () => {
    it('offers the form when generation is switched on', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();

      expect(
        await screen.findByRole('button', { name: /generate ideas/i }),
      ).toBeVisible();
    });

    it.each([
      ['agents_disabled', /paused every agent/i],
      ['content_ideas_disabled', /switched content ideas off/i],
      ['agent_not_installed', /agent is not installed/i],
      ['agent_disabled', /agent is disabled/i],
    ])(
      'says why generation is off when the reason is %s',
      async (reason, copy) => {
        allow('contentIdea:create', 'contentIdea:read');
        getContentIdeaAvailability.mockResolvedValue({
          available: false,
          reason,
        });

        render();

        expect(await screen.findByText(copy)).toBeVisible();
        expect(
          screen.queryByRole('button', { name: /generate ideas/i }),
        ).not.toBeInTheDocument();
      },
    );

    it('leaves the form available when availability cannot be read', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaAvailability.mockRejectedValue(new ApiUnavailableError());

      render();
      await settle();

      expect(
        screen.getByRole('button', { name: /generate ideas/i }),
      ).toBeVisible();
    });

    it('reconciles when the flag is switched off after it reported available', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaAvailability.mockResolvedValueOnce({
        available: true,
        reason: null,
      });
      requestContentIdeas.mockRejectedValue(
        new ApiError(403, 'FEATURE_DISABLED'),
      );
      getContentIdeaAvailability.mockResolvedValue({
        available: false,
        reason: 'content_ideas_disabled',
      });

      render();
      await fillForm();
      await submit();

      expect(
        await screen.findByText(/content ideas are switched off/i),
      ).toBeVisible();
      expect(
        await screen.findByText(/switched content ideas off/i),
      ).toBeVisible();
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: /generate ideas/i }),
        ).not.toBeInTheDocument(),
      );
    });
  });

  it('offers a reader nothing to submit', async () => {
    allow('contentIdea:read');

    render();

    expect(screen.getByText(/no ideas requested yet/i)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /generate ideas/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^topic$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/admin or owner can request/i)).toBeVisible();
  });

  it('renders in Arabic without falling back to the default locale', () => {
    allow('contentIdea:create', 'contentIdea:read');

    renderInOrganization(
      <OrganizationContentIdeasBlock />,
      context({ organization: organization() }),
      { locale: 'ar' },
    );

    expect(screen.getByText('أفكار المحتوى')).toBeVisible();
  });

  describe('starting a project from an idea', () => {
    const succeedWith = async (ideas: unknown[]) => {
      allow(
        'contentIdea:create',
        'contentIdea:read',
        'contentProject:create',
        'contentProject:read',
      );
      requestContentIdeas.mockResolvedValue(operation());
      getContentIdeaOperation.mockResolvedValue(succeeded(ideas));

      render();
      await fillForm();
      await submit();

      await screen.findByText(IDEA.title);
    };

    it('sends the run and the index, and never the idea text', async () => {
      createContentProjectFromIdea.mockResolvedValue({ id: 'proj_1' });

      await succeedWith([IDEA, { ...IDEA, title: 'Second idea' }]);

      const buttons = await screen.findAllByRole('button', {
        name: /start a project/i,
      });

      await userEvent.click(buttons[1]!);

      await waitFor(() =>
        expect(createContentProjectFromIdea).toHaveBeenCalled(),
      );

      const [organizationId, selection, key] =
        createContentProjectFromIdea.mock.calls[0]!;

      expect(organizationId).toBe('org_1');
      expect(selection).toEqual({ sourceRunId: 'op_1', ideaIndex: 1 });
      expect(JSON.stringify(selection)).not.toContain(IDEA.title);
      expect(key).toBe('promote:op_1:1');
    });

    it('offers the project once it exists', async () => {
      createContentProjectFromIdea.mockResolvedValue({ id: 'proj_1' });

      await succeedWith([IDEA]);

      await userEvent.click(
        screen.getByRole('button', { name: /start a project/i }),
      );

      const link = await screen.findByRole('link', { name: /open it/i });

      expect(link).toHaveAttribute(
        'href',
        '/en/organizations/org_1/content-projects/proj_1',
      );
    });

    it('distinguishes a transport failure from a refusal', async () => {
      createContentProjectFromIdea.mockRejectedValue(new ApiUnavailableError());

      await succeedWith([IDEA]);

      await userEvent.click(
        screen.getByRole('button', { name: /start a project/i }),
      );

      expect(
        await screen.findByText(/could not be reached/i),
      ).toBeInTheDocument();
    });

    it('names a refusal the server decided', async () => {
      createContentProjectFromIdea.mockRejectedValue(
        new ApiError(403, 'FORBIDDEN'),
      );

      await succeedWith([IDEA]);

      await userEvent.click(
        screen.getByRole('button', { name: /start a project/i }),
      );

      expect(
        await screen.findByText(/do not have permission to start projects/i),
      ).toBeInTheDocument();
    });

    it('falls back for a refusal it cannot name', async () => {
      createContentProjectFromIdea.mockRejectedValue(
        new ApiError(409, 'CONFLICT'),
      );

      await succeedWith([IDEA]);

      await userEvent.click(
        screen.getByRole('button', { name: /start a project/i }),
      );

      expect(
        await screen.findByText(/could not be turned into a project/i),
      ).toBeInTheDocument();
    });

    it('hides the action from a member who holds neither permission', async () => {
      allow('contentIdea:read');
      requestContentIdeas.mockResolvedValue(operation());
      getContentIdeaOperation.mockResolvedValue(succeeded([IDEA]));

      render({}, { initialEntries: ['/?operation=op_1'] });

      await screen.findByText(IDEA.title);

      expect(
        screen.queryByRole('button', { name: /start a project/i }),
      ).not.toBeInTheDocument();
    });

    it('hides the action from a member who may generate but not promote', async () => {
      allow('contentIdea:read', 'contentIdea:create');
      requestContentIdeas.mockResolvedValue(operation());
      getContentIdeaOperation.mockResolvedValue(succeeded([IDEA]));

      render({}, { initialEntries: ['/?operation=op_1'] });

      await screen.findByText(IDEA.title);

      expect(
        screen.queryByRole('button', { name: /start a project/i }),
      ).not.toBeInTheDocument();
    });

    it('forgets a promotion when a second generation replaces the run', async () => {
      createContentProjectFromIdea.mockResolvedValue({ id: 'proj_1' });

      await succeedWith([IDEA]);

      await userEvent.click(
        screen.getByRole('button', { name: /start a project/i }),
      );

      await screen.findByRole('link', { name: /open it/i });

      getContentIdeaOperation.mockResolvedValue(
        succeeded([{ ...IDEA, title: 'A different idea' }], [], {
          id: 'op_2',
        }),
      );
      requestContentIdeas.mockResolvedValue(operation({ id: 'op_2' }));

      await submit();
      await screen.findByText('A different idea');

      expect(
        screen.getByRole('button', { name: /start a project/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: /open it/i }),
      ).not.toBeInTheDocument();
    });
  });
});
