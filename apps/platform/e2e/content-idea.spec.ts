import { expect, test, type Page, type Route } from '@playwright/test';

import { PLATFORM_BASE_PATH } from '../src/config/paths.js';

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
  statuses?: string[];
  availability?: { available: boolean; reason: string | null };
  submitFailsWith?: number;
};

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

const contentIdeasPath = `${PLATFORM_BASE_PATH}/en/organizations/${ORGANIZATION_ID}/content-ideas`;

const gotoContentIdeas = async (page: Page) => {
  await Promise.all([
    page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/content-ideas/availability'),
    ),
    page.goto(contentIdeasPath),
  ]);
};

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

    await gotoContentIdeas(page);

    await expect(
      page.getByRole('heading', { name: 'Content ideas' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /generate ideas/i }),
    ).toBeVisible();

    await fillForm(page);
    await page.getByRole('button', { name: /generate ideas/i }).click();

    await expect(page.getByText('Queued')).toBeVisible();
    await expect(page.getByText('Running')).toBeVisible();
    await expect(page.getByText(IDEA.title)).toBeVisible();

    await expect(page.getByText(IDEA.hook)).toBeVisible();
    await expect(page.getByText(IDEA.summary)).toBeVisible();
    await expect(page.getByText('Post')).toBeVisible();
    await expect(page.getByText(/grounded in: brand\.voice/i)).toBeVisible();

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

    await expect(page).toHaveURL(new RegExp(`operation=${OPERATION_ID}`));
  });

  test('restores the operation and its result after a reload', async ({
    page,
  }) => {
    const api = await stubApi(page);

    await gotoContentIdeas(page);
    await fillForm(page);
    await page.getByRole('button', { name: /generate ideas/i }).click();

    await expect(page.getByText(IDEA.title)).toBeVisible();

    await page.reload();

    await expect(page.getByText(IDEA.title)).toBeVisible();
    await expect(page.getByText(IDEA.summary)).toBeVisible();
    expect(api.submissions).toHaveLength(1);
  });

  test('reuses the idempotency key after an ambiguous failure and a reload', async ({
    page,
  }) => {
    const api = await stubApi(page, { submitFailsWith: 1 });

    await gotoContentIdeas(page);
    await fillForm(page);
    await page.getByRole('button', { name: /generate ideas/i }).click();

    await expect(page.getByText(/something went wrong/i)).toBeVisible();
    expect(api.submissions).toHaveLength(1);

    const storage = await page.evaluate(() => ({
      ...window.sessionStorage,
    }));
    const pending = storage[`content-idea:pending:${ORGANIZATION_ID}`];

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

    await gotoContentIdeas(page);

    await expect(page.getByText(/switched content ideas off/i)).toBeVisible();
    await expect(
      page.getByRole('button', { name: /generate ideas/i }),
    ).toHaveCount(0);
  });

  test('rides out a rate limit and a server error while polling', async ({
    page,
  }) => {
    let reads = 0;

    await page.route('**/api/auth/**', (route) => {
      const url = route.request().url();

      if (url.includes('get-session')) return json(route, SESSION);
      if (url.includes('get-full-organization'))
        return json(route, ORGANIZATION);
      if (url.includes('/organization/list'))
        return json(route, [ORGANIZATION]);

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

    await gotoContentIdeas(page);
    await fillForm(page);
    await page.getByRole('button', { name: /generate ideas/i }).click();

    await expect(page.getByText(IDEA.title)).toBeVisible();
    expect(reads).toBeGreaterThanOrEqual(3);
  });
});

const useSessionMode = async (page: Page, mode: 'anonymous' | 'outage') => {
  await page.context().addCookies([
    {
      name: 'platform-e2e-session',
      value: mode,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
};

test.describe('App Router route and authentication contracts', () => {
  test('adds the default Arabic locale to a locale-less deep link', async ({
    page,
  }) => {
    await page.goto(`${PLATFORM_BASE_PATH}/organizations?view=archived`);

    await expect(page).toHaveURL(
      new RegExp(`${PLATFORM_BASE_PATH}/ar/organizations\\?view=archived$`),
    );
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('redirects an anonymous private deep link before rendering its UI', async ({
    page,
  }) => {
    await useSessionMode(page, 'anonymous');
    const returnTo = `/organizations/${ORGANIZATION_ID}/content-projects/project_1?revision=2`;

    await page.goto(`${PLATFORM_BASE_PATH}/en${returnTo}`);

    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `${PLATFORM_BASE_PATH}/en/sign-in` &&
        url.searchParams.get('returnTo') === returnTo,
    );
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('Kettle teardown')).toHaveCount(0);
  });

  test('keeps an anonymous visitor on sign-in and sends a signed-in visitor home', async ({
    page,
  }) => {
    await useSessionMode(page, 'anonymous');
    await page.goto(`${PLATFORM_BASE_PATH}/en/sign-in`);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await page.context().clearCookies();
    await page.goto(`${PLATFORM_BASE_PATH}/en/sign-in`);
    await expect(page).toHaveURL(new RegExp(`${PLATFORM_BASE_PATH}/en$`));
    await expect(
      page.getByRole('main').getByText('smoke@example.test'),
    ).toBeVisible();
  });

  test('renders the localized not-found page for an unsupported path', async ({
    page,
  }) => {
    const response = await page.goto(
      `${PLATFORM_BASE_PATH}/en/not-a-real-route`,
    );

    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole('heading', { name: 'Page not found' }),
    ).toBeVisible();
  });

  test('does not misclassify an API outage as an anonymous session', async ({
    page,
  }) => {
    await useSessionMode(page, 'outage');
    const privatePath = `${PLATFORM_BASE_PATH}/en/organizations`;
    const response = await page.goto(privatePath);

    expect(response?.status()).toBeGreaterThanOrEqual(500);
    await expect(page).toHaveURL(privatePath);
    await expect(
      page.getByRole('heading', { name: 'Something went wrong' }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/\/sign-in/);
  });
});
