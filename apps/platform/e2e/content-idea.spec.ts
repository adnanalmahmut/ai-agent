import { expect, test, type Page, type Route } from '@playwright/test';

import { PLATFORM_BASE_PATH } from '../src/config/paths.js';

/**
 * The content-idea flow, in a real browser.
 *
 * Only the cases that need one. The component suite already asserts the logic
 * in jsdom — what it cannot assert is that the built bundle boots, that the
 * router's basename works, that the operation genuinely survives a *browser*
 * reload, and that a key minted with `crypto.randomUUID`, paired with a
 * `crypto.subtle` digest of the request and kept in real `sessionStorage`,
 * survives the same reload without the request text going with it. Each of
 * those is a browser fact.
 *
 * Every request is fulfilled from the fixtures below. No backend, no database,
 * no provider, and no credential — which is what keeps this runnable in CI on
 * every pull request rather than on a schedule nobody watches.
 */

const ORGANIZATION_ID = 'org_smoke';
const USER_ID = 'user_smoke';

const SESSION = {
  session: {
    id: 'session_smoke',
    userId: USER_ID,
    expiresAt: '2099-01-01T00:00:00.000Z',
    token: 'smoke',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    activeOrganizationId: ORGANIZATION_ID,
  },
  user: {
    id: USER_ID,
    name: 'Smoke Operator',
    email: 'smoke@example.test',
    emailVerified: true,
    image: null,
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

const ORGANIZATION = {
  id: ORGANIZATION_ID,
  name: 'Smoke Works',
  slug: 'smoke-works',
  logo: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  metadata: null,
  /** `owner`, so the client-side gate opens the form. The backend still decides. */
  members: [
    {
      id: 'member_smoke',
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      role: 'owner',
      createdAt: '2026-01-01T00:00:00.000Z',
      user: {
        id: USER_ID,
        name: 'Smoke Operator',
        email: 'smoke@example.test',
        image: null,
      },
    },
  ],
  invitations: [],
};

const IDEA = {
  title: 'Ninety seconds is a physics number',
  hook: 'Your kettle is not slow. Its element is the wrong shape.',
  angle: 'Lead with the engineering, land on the 7am routine.',
  summary:
    'Open on the element, explain why surface area beats wattage, and close on what that buys somebody before work.',
  suggestedFormat: 'post',
};

const OPERATION_ID = 'op_smoke_1';

/** The backend's success envelope, which the client unwraps. */
const envelope = (data: unknown) => ({
  success: true,
  data,
  meta: { requestId: 'req_smoke', timestamp: '2026-01-01T00:00:00.000Z' },
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

type Options = {
  /** The sequence of statuses the operation read returns, one per call. */
  statuses?: string[];
  availability?: { available: boolean; reason: string | null };
  /** Fails the first N submissions with this status before accepting. */
  submitFailsWith?: number;
};

/**
 * Everything the screen talks to, recorded and answered.
 *
 * Returned rather than asserted on inside, so each test names the property it
 * cares about — how many runs were purchased, which idempotency keys were sent
 * — instead of every test carrying the same block of expectations.
 */
async function stubApi(page: Page, options: Options = {}) {
  const statuses = [...(options.statuses ?? ['SUCCEEDED'])];
  const submissions: { key: string | undefined; body: unknown }[] = [];
  const polls: string[] = [];
  let remainingFailures = options.submitFailsWith ?? 0;

  await page.route('**/api/auth/**', (route) => {
    const url = route.request().url();

    if (url.includes('get-session')) return json(route, SESSION);
    if (url.includes('get-full-organization')) return json(route, ORGANIZATION);
    if (url.includes('/organization/list')) return json(route, [ORGANIZATION]);

    return json(route, {});
  });

  await page.route('**/api/organizations/archived', (route) =>
    json(route, envelope([])),
  );

  await page.route(
    `**/api/organizations/${ORGANIZATION_ID}/content-ideas**`,
    (route) => {
      const request = route.request();
      const url = new URL(request.url());

      if (url.pathname.endsWith('/availability')) {
        return json(
          route,
          envelope(options.availability ?? { available: true, reason: null }),
        );
      }

      if (request.method() === 'POST') {
        submissions.push({
          key: request.headers()['idempotency-key'],
          body: request.postDataJSON(),
        });

        if (remainingFailures > 0) {
          remainingFailures -= 1;

          /**
           * A 502, not a 400. The distinction is the whole point of the
           * idempotency test: the server never *decided*, so acceptance is
           * unknown and the key has to survive.
           */
          return json(route, { error: { code: 'BAD_GATEWAY' } }, 502);
        }

        return json(
          route,
          envelope({
            id: OPERATION_ID,
            status: 'QUEUED',
            output: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            completedAt: null,
          }),
          201,
        );
      }

      const operationId = url.pathname.split('/').pop() ?? '';

      polls.push(operationId);

      // The last status repeats once the sequence is exhausted, so a run that
      // reached a terminal state stays there however many times it is read.
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0];

      return json(
        route,
        envelope({
          id: operationId,
          status,
          output:
            status === 'SUCCEEDED'
              ? { ideas: [IDEA], sources: ['brand.voice'] }
              : null,
          createdAt: '2026-01-01T00:00:00.000Z',
          completedAt:
            status === 'SUCCEEDED' ? '2026-01-01T00:00:05.000Z' : null,
        }),
      );
    },
  );

  return { submissions, polls };
}

/**
 * Explicitly includes the platform mount point.
 *
 * `baseURL` is intentionally configured with that same mount point, but an
 * absolute app path keeps the smoke test independent of URL-resolution
 * differences between browser runners. `/en/...` would skip the mount point,
 * whereas `/platform/en/...` exercises the real router basename.
 */
const contentIdeasPath = `${PLATFORM_BASE_PATH}/en/organizations/${ORGANIZATION_ID}/content-ideas`;

const fillForm = async (page: Page) => {
  await page.getByLabel(/^topic$/i).fill('Electric kettles');
  await page.getByLabel(/^goal$/i).fill('Sell the autumn range');
  await page.getByLabel(/^audience/i).fill('Home cooks');
  await page.getByLabel(/guidance/i).fill('Keep it concrete.');
  await page.getByLabel(/content language/i).selectOption('en');
  await page.getByLabel(/how many/i).fill('3');
};

test.describe('content ideas in a browser', () => {
  test('loads the route, generates, polls, and renders the result', async ({
    page,
  }) => {
    const api = await stubApi(page, {
      statuses: ['QUEUED', 'RUNNING', 'SUCCEEDED'],
    });

    await page.goto(contentIdeasPath);

    // The route loads and the form is offered, which together prove the bundle
    // booted and the router's basename resolved.
    await expect(page.getByRole('heading', { name: 'Content ideas' })).toBeVisible();
    await expect(page.getByRole('button', { name: /generate ideas/i })).toBeVisible();

    await fillForm(page);
    await page.getByRole('button', { name: /generate ideas/i }).click();

    // Queued, then running, then the ideas — the sequence the screen exists to
    // show honestly rather than hiding behind one spinner.
    await expect(page.getByText('Queued')).toBeVisible();
    await expect(page.getByText('Running')).toBeVisible();
    await expect(page.getByText(IDEA.title)).toBeVisible();

    // Every field of the richer contract, not only the title.
    await expect(page.getByText(IDEA.hook)).toBeVisible();
    await expect(page.getByText(IDEA.summary)).toBeVisible();
    await expect(page.getByText('Post')).toBeVisible();
    await expect(page.getByText(/grounded in: brand\.voice/i)).toBeVisible();

    // The request carried the whole contract and an idempotency key.
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0]?.key).toEqual(expect.any(String));
    expect(api.submissions[0]?.body).toEqual({
      topic: 'Electric kettles',
      goal: 'Sell the autumn range',
      language: 'en',
      audience: 'Home cooks',
      guidance: 'Keep it concrete.',
      numberOfIdeas: 3,
    });

    // And the operation is in the address, which is what the next test needs.
    await expect(page).toHaveURL(new RegExp(`operation=${OPERATION_ID}`));
  });

  /**
   * A real reload, which is the case jsdom cannot produce.
   *
   * Everything in memory is gone; the run is recovered from the address alone,
   * and nothing is purchased to get it back.
   */
  test('restores the operation and its result after a reload', async ({
    page,
  }) => {
    const api = await stubApi(page);

    await page.goto(contentIdeasPath);
    await fillForm(page);
    await page.getByRole('button', { name: /generate ideas/i }).click();

    await expect(page.getByText(IDEA.title)).toBeVisible();

    await page.reload();

    await expect(page.getByText(IDEA.title)).toBeVisible();
    await expect(page.getByText(IDEA.summary)).toBeVisible();
    // One purchase, across both page views.
    expect(api.submissions).toHaveLength(1);
  });

  /**
   * The idempotency key across a browser reload, which is what
   * `sessionStorage` is for.
   *
   * The first submission fails in transport, so acceptance is unknown: the run
   * may exist and may be billed. Reloading and asking the same question again
   * must reuse the key, or the reader pays twice for one answer.
   */
  test('reuses the idempotency key after an ambiguous failure and a reload', async ({
    page,
  }) => {
    const api = await stubApi(page, { submitFailsWith: 1 });

    await page.goto(contentIdeasPath);
    await fillForm(page);
    await page.getByRole('button', { name: /generate ideas/i }).click();

    await expect(page.getByText(/something went wrong/i)).toBeVisible();
    expect(api.submissions).toHaveLength(1);

    /**
     * What survives the reload is an identity, not the request.
     *
     * Real `sessionStorage` in a real browser, which is the only place this can
     * honestly be checked. The record used to be the request itself,
     * serialized, so the operator's topic, goal, audience and guidance sat in a
     * store every script on the origin can read. Only sameness is ever asked of
     * the value, and a SHA-256 digest preserves sameness without keeping the
     * text.
     */
    const storage = await page.evaluate(() => ({
      ...window.sessionStorage,
    }));
    const pending = storage[`content-idea:pending:${ORGANIZATION_ID}`];

    // Not vacuous: the ambiguous failure is exactly when a record must exist.
    expect(pending).toEqual(expect.any(String));
    expect(JSON.parse(pending ?? 'null')).toEqual({
      idempotencyKey: api.submissions[0]?.key,
      requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const dump = JSON.stringify(storage);

    for (const typed of [
      'Electric kettles',
      'Sell the autumn range',
      'Home cooks',
      'Keep it concrete.',
    ]) {
      expect(dump).not.toContain(typed);
    }

    await page.reload();
    await fillForm(page);
    await page.getByRole('button', { name: /generate ideas/i }).click();

    await expect(page.getByText(IDEA.title)).toBeVisible();

    expect(api.submissions).toHaveLength(2);
    expect(api.submissions[1]?.key).toBe(api.submissions[0]?.key);
  });

  test('says why generation is off and offers no form', async ({ page }) => {
    await stubApi(page, {
      availability: { available: false, reason: 'content_ideas_disabled' },
    });

    await page.goto(contentIdeasPath);

    await expect(page.getByText(/switched content ideas off/i)).toBeVisible();
    await expect(
      page.getByRole('button', { name: /generate ideas/i }),
    ).toHaveCount(0);
  });

  /**
   * A poll that fails transiently must not abandon a run that is still going.
   *
   * The 429 is the case that matters: it is this tab's own polling spending the
   * route budget, and stopping there would strand a billed run behind copy
   * inviting the resubmission that buys a second one.
   */
  test('rides out a rate limit and a server error while polling', async ({
    page,
  }) => {
    let reads = 0;

    await page.route('**/api/auth/**', (route) => {
      const url = route.request().url();

      if (url.includes('get-session')) return json(route, SESSION);
      if (url.includes('get-full-organization')) return json(route, ORGANIZATION);
      if (url.includes('/organization/list')) return json(route, [ORGANIZATION]);

      return json(route, {});
    });

    await page.route('**/api/organizations/archived', (route) =>
      json(route, envelope([])),
    );

    await page.route(
      `**/api/organizations/${ORGANIZATION_ID}/content-ideas**`,
      (route) => {
        const request = route.request();
        const url = new URL(request.url());

        if (url.pathname.endsWith('/availability')) {
          return json(route, envelope({ available: true, reason: null }));
        }

        if (request.method() === 'POST') {
          return json(
            route,
            envelope({
              id: OPERATION_ID,
              status: 'QUEUED',
              output: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              completedAt: null,
            }),
            201,
          );
        }

        reads += 1;

        if (reads === 1) return json(route, { error: {} }, 429);
        if (reads === 2) return json(route, { error: {} }, 503);

        return json(
          route,
          envelope({
            id: OPERATION_ID,
            status: 'SUCCEEDED',
            output: { ideas: [IDEA], sources: [] },
            createdAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:05.000Z',
          }),
        );
      },
    );

    await page.goto(contentIdeasPath);
    await fillForm(page);
    await page.getByRole('button', { name: /generate ideas/i }).click();

    // It kept asking through both, and the run finished.
    await expect(page.getByText(IDEA.title)).toBeVisible();
    expect(reads).toBeGreaterThanOrEqual(3);
  });
});
