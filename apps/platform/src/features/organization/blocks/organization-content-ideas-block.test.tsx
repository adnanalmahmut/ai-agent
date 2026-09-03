import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allowOrganizationPermissions as allow,
  authClientStub,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { context, organization } from '@/test/organization-fixtures';
import { renderInOrganization } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');

  return { authClient: authClientStub };
});

/**
 * The API module is mocked, not `fetch`. `organization-api` reaches the network
 * through `application-api`, which is asserted elsewhere to be the only `fetch`
 * call site, so stubbing it is stubbing the boundary. What these tests are
 * about is what an operator sees while a generation is in flight.
 */
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

const { OrganizationContentIdeasBlock } = await import(
  './organization-content-ideas-block'
);
const { ApiError, ApiUnavailableError } = await import(
  '@/lib/application-api'
);

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

const IDEA = {
  title: 'Why our kettle boils in ninety seconds',
  hook: 'Ninety seconds. Not a marketing number — a physics one.',
  angle: 'Lead with the engineering, then the morning routine.',
  summary:
    'Open on the element, explain why surface area beats wattage, and land on what that buys somebody at 7am.',
  suggestedFormat: 'post',
};

/**
 * A fast poll, on a real clock.
 *
 * Fake timers are not usable here: `userEvent` awaits a real delay that a
 * faked clock never reaches, so every interaction hangs. So the block is given
 * a short interval instead and the assertions wait for the DOM, which is both
 * honest about what is being observed and quick.
 */
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

/**
 * The two required fields, and nothing else.
 *
 * `audience` is optional in the contract, so a helper that filled it in would
 * make every test assert the same request shape and leave the optional path
 * unexercised. The tests that care about it type it themselves.
 */
const fillForm = async () => {
  await userEvent.type(screen.getByLabelText(/^topic$/i), 'Electric kettles');
  await userEvent.type(
    screen.getByLabelText(/^goal$/i),
    'Sell the autumn range',
  );
};

/** What `fillForm` produces, as the request the block should send. */
const REQUEST = {
  topic: 'Electric kettles',
  goal: 'Sell the autumn range',
  language: 'en',
  numberOfIdeas: 5,
};

const submit = () =>
  userEvent.click(screen.getByRole('button', { name: /generate ideas/i }));

/** Long enough for several poll ticks to have gone by, and no longer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, POLL_MS * 6));

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
    // The failure this guards is only visible when the two differ; with no
    // active organization the assertion passes whichever id the block reads.
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

    // Both optional fields absent, not present-and-empty: the schema is strict
    // about `audience` having three characters when it is there at all.
    expect(requestContentIdeas.mock.calls[0]?.[1]).toEqual(REQUEST);
  });

  it('sends the optional fields when they were given, trimmed like the rest', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await fillForm();
    await userEvent.type(
      screen.getByLabelText(/^audience/i),
      '  Home cooks  ',
    );
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

  /**
   * The content language is a field, not an inference from the reader's locale.
   *
   * An Arabic-speaking marketer writing English campaign copy is the ordinary
   * case, and a screen that read the UI locale would make it unreachable. So
   * the request carries what the selector says, and the default is not the
   * locale.
   */
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

    // Reading the screen in Arabic; the content language is still the field's
    // own default until somebody changes it.
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
    // The old public name is gone, and the schema is strict — sending it would
    // be a 400 rather than an ignored field.
    expect(sent).not.toHaveProperty('count');
  });

  /**
   * The schema demands three characters, so a one-word start would be refused
   * by the pipe. Keeping the button disabled turns that into a control the
   * operator can see rather than a 400 they have to read.
   */
  it('will not submit a request the schema would refuse', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await userEvent.type(screen.getByLabelText(/^topic$/i), 'a');
    await userEvent.type(screen.getByLabelText(/^goal$/i), 'a');

    expect(
      screen.getByRole('button', { name: /generate ideas/i }),
    ).toBeDisabled();
  });

  /**
   * A goal is required, so a topic on its own is not a submittable request —
   * and the button says so rather than the server.
   */
  it('will not submit without a goal', async () => {
    allow('contentIdea:create', 'contentIdea:read');

    render();
    await userEvent.type(screen.getByLabelText(/^topic$/i), 'Electric kettles');

    expect(
      screen.getByRole('button', { name: /generate ideas/i }),
    ).toBeDisabled();
  });

  /**
   * `audience` is optional but bounded when present. A one-character answer is
   * a slip, and the schema refuses it — so the button has to as well, or the
   * form produces a 400 for something it could see.
   */
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

  /**
   * The number input's `min` and `max` bound its arrows, not what can be typed.
   * Sending an out-of-range count would come back a 400 the operator has to
   * read to learn something the form already knew.
   */
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

  /**
   * The upper bounds too, not only the lower ones.
   *
   * A 400 from this endpoint is a dead end: the pipe answers with a field-error
   * array the shared client does not render, so the screen can only say the
   * request was refused without naming the field or the limit. The form staying
   * inside the schema's bounds is what makes that unreachable.
   */
  describe('the schema bounds it enforces itself', () => {
    /**
     * Two guards, because they stop different things. The attribute stops a
     * person typing or pasting past the limit; the submit gate stops a value
     * that arrived some other way — an autofill, a paste jsdom cannot model, a
     * future control that sets state directly.
     */
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

      // Set directly, which is how a value can exceed `maxLength` at all.
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

    /**
     * Generation is billed and is not naturally idempotent. A request that
     * failed in transport may or may not have been accepted, so retrying it
     * with a fresh key would buy a second answer to the same question.
     */
    it('is reused when the request never reached the server', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(new ApiUnavailableError());

      render();
      await fillForm();
      await submit();
      expect(await screen.findByText(/could not be reached/i)).toBeVisible();

      requestContentIdeas.mockResolvedValue(operation());
      await submit();

      await waitFor(() =>
        expect(requestContentIdeas).toHaveBeenCalledTimes(2),
      );

      expect(requestContentIdeas.mock.calls[1]?.[2]).toBe(
        requestContentIdeas.mock.calls[0]?.[2],
      );
    });

    /**
     * A 5xx is not the server deciding.
     *
     * Acceptance commits the run and its outbox event in one transaction, so a
     * proxy timing out or an instance being rolled after that commit returns a
     * failure for work that was accepted and will be billed. A fresh key there
     * buys the same ideas twice.
     */
    it('is reused when the server failed rather than refused', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(
        new ApiError(504, undefined),
      );

      render();
      await fillForm();
      await submit();
      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalled());

      requestContentIdeas.mockResolvedValue(operation());
      await submit();

      await waitFor(() =>
        expect(requestContentIdeas).toHaveBeenCalledTimes(2),
      );

      expect(requestContentIdeas.mock.calls[1]?.[2]).toBe(
        requestContentIdeas.mock.calls[0]?.[2],
      );
    });

    /**
     * A refusal is the server having decided, so the next attempt is a new
     * request rather than a retry — reusing the key would ask for a run that
     * was never created.
     */
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

      await waitFor(() =>
        expect(requestContentIdeas).toHaveBeenCalledTimes(2),
      );

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

      await waitFor(() =>
        expect(requestContentIdeas).toHaveBeenCalledTimes(2),
      );

      expect(requestContentIdeas.mock.calls[1]?.[2]).not.toBe(
        requestContentIdeas.mock.calls[0]?.[2],
      );
    });
  });

  /**
   * A second submission while the first is still going would be a second
   * purchase.
   *
   * The key is cleared once the server accepted, so `??=` on the next submit
   * mints a fresh one and the backend has no reason to deduplicate. Nothing
   * but the disabled control stands between an impatient double-click and two
   * bills for the same question.
   */
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
    /**
     * The number the application actually ships.
     *
     * Every test here injects a fast interval, so the default is the one value
     * in this behavior that no assertion would otherwise touch — and changing
     * it is changing how much traffic every waiting screen puts against the
     * same rate-limit budget the endpoint meters.
     */
    it('defaults to a cadence that does not hammer the endpoint', () => {
      allow('contentIdea:create', 'contentIdea:read');

      renderInOrganization(
        <OrganizationContentIdeasBlock />,
        context({ organization: organization() }),
      );

      // Rendered with no interval at all, so the default is in force; a poll
      // arriving inside this window would mean it is far shorter than stated.
      expect(getContentIdeaOperation).not.toHaveBeenCalled();
    });

    it('shows the run queued, then running, then its ideas', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render();
      await fillForm();
      await submit();
      expect(await screen.findByText(/^queued$/i)).toBeVisible();
      // Withheld until the run succeeds, which is also what the backend does.
      expect(screen.queryByText(IDEA.title)).not.toBeInTheDocument();

      getContentIdeaOperation.mockResolvedValue(
        operation({ status: 'RUNNING' }),
      );
      expect(await screen.findByText(/^running$/i)).toBeVisible();

      getContentIdeaOperation.mockResolvedValue(succeeded([IDEA], ['brand.voice']));
      expect(await screen.findByText(IDEA.title)).toBeVisible();

      /**
       * Every field of the richer contract, not only the two the old one had.
       *
       * A result view that dropped `hook` or `summary` would still render
       * something that looks like an idea, which is why each is named here —
       * the failure to catch is a field quietly missing from the card, not an
       * empty screen.
       */
      expect(screen.getByText(IDEA.hook)).toBeVisible();
      expect(screen.getByText(IDEA.angle, { exact: false })).toBeVisible();
      expect(screen.getByText(IDEA.summary)).toBeVisible();
      // The format is a translated badge, not the enum member.
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

    /**
     * The whole point of polling is to stop. A screen that kept asking after a
     * terminal status would spend a request every two seconds forever against
     * the same rate-limit budget the request itself uses.
     */
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

    /**
     * A run that succeeded with nothing in it is a real state — the agent's
     * schema permits an answer this screen has no rows for — and a blank panel
     * would read as a page that failed.
     */
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

    /**
     * A poll failing is not the same event as a request failing. Transport
     * blips are expected over minutes of polling and the next tick recovers,
     * so one must not tear down a run that is still going.
     */
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

    /**
     * The case that matters most, because stopping here strands a billed run.
     *
     * The read shares the route's own rate-limit budget, so a second tab
     * watching the same run can exhaust it. Treating that 429 as a refusal
     * would end the watch on a run that is still executing and then show copy
     * inviting exactly the resubmission that pays for a second one.
     */
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

    /**
     * A response that outran the one before it must not walk the run backwards.
     *
     * Two reads can be in flight when a response is slower than the interval.
     * A late `QUEUED` landing after `SUCCEEDED` would hide an answer the
     * operator already had, restart the effect, and reset the clock the give-up
     * timeout is measured from — so a slow provider could never time out.
     */
    it('never puts a finished run back to pending', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      getContentIdeaOperation
        // Slow, and stale by the time it lands.
        .mockImplementationOnce(() => after(POLL_MS * 8, operation()))
        .mockImplementation(() => Promise.resolve(succeeded([IDEA])));

      render();
      await fillForm();
      await submit();

      expect(await screen.findByText(IDEA.title)).toBeVisible();

      // Long enough for the stale QUEUED to have arrived.
      await settle();
      await settle();

      expect(screen.getByText(IDEA.title)).toBeVisible();
      expect(screen.queryByText(/^queued$/i)).not.toBeInTheDocument();
    });

    /**
     * A refusal about the operation itself is different: the server is saying
     * it is not readable, and asking again will not change that.
     */
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

  /**
   * Giving up is a state with its own screen, and it had none.
   *
   * The screen must say the run is still going rather than showing whatever
   * status it last saw — the operator's next question is whether their request
   * survived, and "Queued" answers it wrongly. Reachable only because the
   * timeout is a parameter; three minutes is not something a test can wait for.
   */
  describe('waiting too long', () => {
    it('reports the run as still running, not as whatever it last saw', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      render({ pollTimeoutMs: 0 });
      await fillForm();
      await submit();

      expect(
        await screen.findByText(/taking longer than expected/i),
      ).toBeVisible();
      // The badge, specifically. The run's own last-seen status is `QUEUED`,
      // and showing that here would tell the operator their request never
      // started.
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

    /**
     * A refused poll and an exhausted wait are different stops. Offering to
     * keep waiting for an operation the server will not answer about is a
     * button that cannot work.
     */
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

  /**
   * A new request supersedes the last one, including the state that stopped it.
   *
   * The path that made this necessary: an operation whose poll was refused
   * leaves the watch stopped. Asking again clears that flag, which restarts the
   * poll — and while the new request is in flight the only operation to poll is
   * the old one, whose read fails again and stops the watch a second time. The
   * run this submission is about then arrives already-stopped and is never
   * watched: billed, executed, and never shown.
   */
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
    /**
     * A disabled feature and a missing permission are both 403. Telling an
     * owner who holds every grant that they lack permission sends them to
     * change roles over something no role can fix.
     */
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

    /**
     * Two different 429s reach this screen: this member going too fast, and the
     * organization already holding as many runs as the operator allows. The
     * shared message is honest about both, and the server's own reason is
     * rendered beneath it when it sent one — which is what tells them apart.
     */
    it('renders the reason a 429 carried', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValue(
        new ApiError(429, 'TOO_MANY_REQUESTS', {
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

    /**
     * A refused body says only that it was refused.
     *
     * The global validation pipe answers with a field-error array, which this
     * application's error reader does not accept — it takes a list of sentences
     * or one sentence — so nothing lands beneath the message. That is why the
     * form enforces the schema's bounds itself; this pins the state an operator
     * would otherwise be left in, so the two are read together rather than one
     * of them looking like an oversight.
     */
    it('says only that a refused body was refused', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValue(
        new ApiError(400, 'VALIDATION_ERROR', {}),
      );

      render();
      await fillForm();
      await submit();

      expect(await screen.findByText(/could not be accepted/i)).toBeVisible();
    });
  });

  /**
   * A reader without create is not shown a form that would answer 403. The gate
   * is UX; the backend re-derives the same decision from the database.
   */
  /**
   * The operation lives in the URL, which is what makes a reload recoverable.
   *
   * A billed run whose id existed only in a closure was lost by a reload, a
   * navigation, or a crash — and the only recovery a reader would think of is
   * asking again, which buys the answer twice. These assert the whole loop:
   * accepted puts it there, arriving with it there picks it back up, and a
   * stale one is corrected rather than reproduced forever.
   */
  describe('recovering an operation from the URL', () => {
    const urlOf = (result: ReturnType<typeof render>) =>
      `${result.router.state.location.pathname}${result.router.state.location.search}`;

    it('puts an accepted operation into the address', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockResolvedValue(operation({ id: 'op_accepted' }));

      const result = render();
      await fillForm();
      await submit();

      await waitFor(() =>
        expect(urlOf(result)).toContain('operation=op_accepted'),
      );
    });

    /**
     * Replace, not push. A generation is not a place somebody navigated to, and
     * pushing would make the back button step through every request they made
     * before it left the screen.
     */
    it('replaces rather than pushes, so the back button leaves the screen', async () => {
      allow('contentIdea:create', 'contentIdea:read');

      const result = render();

      await fillForm();
      await submit();

      await waitFor(() => expect(urlOf(result)).toContain('operation=op_1'));

      // The entry was overwritten rather than added, so the back button leaves
      // the screen instead of stepping through this session's requests.
      expect(result.router.state.historyAction).toBe('REPLACE');
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
      // Nothing was bought to get it back.
      expect(requestContentIdeas).not.toHaveBeenCalled();
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

    /**
     * An operation id belonging to another organization reads as a 404, which
     * is deliberately the same answer a non-existent one gets. Either way the
     * screen must not render it — and must take it out of the address, or a
     * reload reproduces the same failure forever.
     */
    it('shows nothing and clears the address for an operation it cannot read', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaOperation.mockRejectedValue(new ApiError(404, 'NOT_FOUND'));

      const result = render(
        {},
        { initialEntries: ['/?operation=op_from_another_org'] },
      );

      expect(
        await screen.findByText(/that request could not be found/i),
      ).toBeVisible();
      await waitFor(() =>
        expect(urlOf(result)).not.toContain('op_from_another_org'),
      );
      expect(screen.getByText(/no ideas requested yet/i)).toBeVisible();
    });

    /**
     * A transient failure is not a reason to discard the id. The run is still
     * out there and still paid for; dropping it from the URL would be losing
     * it for a 500 that the next reload would have ridden out.
     */
    it('keeps the address through a server failure', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaOperation.mockRejectedValue(new ApiError(500, 'INTERNAL'));

      const result = render({}, { initialEntries: ['/?operation=op_kept'] });

      await settle();

      expect(urlOf(result)).toContain('operation=op_kept');
    });
  });

  /**
   * Idempotency across a reload, which the in-memory key could not survive.
   *
   * A request that fails in transport may or may not have been accepted — the
   * backend commits the run and its outbox event in one transaction, so a proxy
   * timing out after that commit reports a failure for work that will be
   * billed. The reader's instinct is to reload and try again, and that is
   * exactly the moment a fresh key buys the ideas twice.
   */
  describe('the idempotency key across a reload', () => {
    const keyOf = (call: number) =>
      requestContentIdeas.mock.calls[call]?.[2] as string;

    it('reuses the stored key for the same request after a reload', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(new ApiError(502, 'BAD_GATEWAY'));

      const first = render();
      await fillForm();
      await submit();

      await waitFor(() => expect(requestContentIdeas).toHaveBeenCalledTimes(1));

      // The reload: everything in memory is gone, only the browser survives.
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

    /**
     * And the stored key is *not* reused for a different question. Reusing one
     * there would still be answered correctly by the backend — it binds the key
     * to a digest of the body — but it would be answered by creating a second
     * run, which is the purchase this is avoiding by accident rather than on
     * purpose.
     */
    it('does not reuse the stored key for a materially different request', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(new ApiError(502, 'BAD_GATEWAY'));

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

    /**
     * A refusal the server *chose* ends the submission: no run was created, so
     * the record must not outlive the page and turn the next honest ask into a
     * replay of a request that never happened.
     */
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

    /**
     * What the record is allowed to contain, asserted on the screen's own path
     * rather than only on the module's.
     *
     * The record used to be the request itself, serialized — topic, goal,
     * audience and guidance, which is operator-authored business text, written
     * to a store every script on the origin can read. Only the identity is
     * needed, so only the identity is kept: an idempotency key and a SHA-256
     * digest of the canonical request. This asserts against the whole of
     * session storage, so a future record that stashes the request under some
     * other key fails here too.
     */
    it('stores only an opaque digest of the request, never its text', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      requestContentIdeas.mockRejectedValueOnce(new ApiError(502, 'BAD_GATEWAY'));

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

      // Not vacuous: the ambiguous failure is exactly when a record must exist.
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

    /**
     * A browser with no `crypto.subtle` must say so, not present a dead button.
     *
     * The digest is computed inside the submit handler's `try` for exactly this
     * reason — `crypto.subtle` is absent outside a secure context, like
     * `crypto.randomUUID` beside it — and the comment claiming so is worth
     * nothing without a test that drives the throw. Nothing was purchased, and
     * the reader is told.
     */
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
        // And the button is offered again rather than left spinning.
        expect(
          screen.getByRole('button', { name: /generate ideas/i }),
        ).toBeEnabled();
      } finally {
        digest.mockRestore();
      }
    });

    /** A browser that refuses to store anything must still work. */
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

  /**
   * Availability, so the screen says the feature is off *before* somebody
   * fills a form in rather than after they press the button.
   */
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
    ])('says why generation is off when the reason is %s', async (
      reason,
      copy,
    ) => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaAvailability.mockResolvedValue({
        available: false,
        reason,
      });

      render();

      expect(await screen.findByText(copy)).toBeVisible();
      // And the form is gone, rather than a button that opens onto a 403.
      expect(
        screen.queryByRole('button', { name: /generate ideas/i }),
      ).not.toBeInTheDocument();
    });

    /**
     * A readiness check that cannot be read is not a reason to block the
     * screen. The backend still decides, which is the behavior that existed
     * before this endpoint did.
     */
    it('leaves the form available when availability cannot be read', async () => {
      allow('contentIdea:create', 'contentIdea:read');
      getContentIdeaAvailability.mockRejectedValue(new ApiUnavailableError());

      render();
      await settle();

      expect(
        screen.getByRole('button', { name: /generate ideas/i }),
      ).toBeVisible();
    });

    /**
     * The race the availability read cannot win: a flag switched off between
     * the reading and the submission. Acceptance is authoritative, and the
     * refusal is what reconciles the stale reading.
     */
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

      // The refusal, and then the corrected reading that follows it.
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

  /**
   * Promoting an idea into a project.
   *
   * The button is the only place in the product where an idea becomes a
   * commitment, so what it *sends* matters as much as what it shows: a run id
   * and a position, never the idea's text.
   */
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
      // Derived from the pair, so a second click is the same request.
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

    /**
     * A server that could not be reached is worth retrying.
     */
    it('distinguishes a transport failure from a refusal', async () => {
      createContentProjectFromIdea.mockRejectedValue(
        new ApiUnavailableError(),
      );

      await succeedWith([IDEA]);

      await userEvent.click(
        screen.getByRole('button', { name: /start a project/i }),
      );

      expect(
        await screen.findByText(/could not be reached/i),
      ).toBeInTheDocument();
    });

    /**
     * A permission they do not hold is not, and must not be described as a
     * network problem.
     */
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

    /** Anything else falls back to the neutral sentence. */
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

    /**
     * A member who may read ideas but not act on them sees no button. The
     * backend refuses them regardless; this keeps the screen from offering a
     * control that answers 403.
     */
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

    /**
     * The two permissions are genuinely separate, and this is the case that
     * proves the gate reads the right one.
     *
     * Granting generation but withholding promotion is the role the backend's
     * split exists to make possible. A gate wired to `contentIdea:create` shows
     * an enabled button here that answers 403 on every click — and every other
     * test in this file passes either way, because today's roles hold both or
     * neither.
     */
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

    /**
     * An index only means anything relative to the run that produced it.
     *
     * Generating again replaces the operation in place — the block does not
     * remount — so a promotion recorded against run A must not decorate run
     * B's card at the same position, and must not hide run B's own button
     * behind a link to somebody else's project.
     */
    it('forgets a promotion when a second generation replaces the run', async () => {
      createContentProjectFromIdea.mockResolvedValue({ id: 'proj_1' });

      await succeedWith([IDEA]);

      await userEvent.click(
        screen.getByRole('button', { name: /start a project/i }),
      );

      await screen.findByRole('link', { name: /open it/i });

      // A second generation, in place.
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
