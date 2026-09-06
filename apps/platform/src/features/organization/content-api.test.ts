import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_PATH } from '@/config/paths';
import { ApiError, errorDetailLines } from '@/lib/application-api';

import {
  CONTENT_IDEA_FORMATS,
  CONTENT_IDEA_LANGUAGES,
  CONTENT_IDEA_STATUSES,
  CONTENT_IDEA_UNAVAILABLE_REASONS,
  createContentProjectFromIdea,
  getContentIdeaAvailability,
  getContentIdeaOperation,
  getContentProject,
  listContentProjects,
  requestContentIdeas,
  type ContentIdeaOperation,
  type ContentProjectDetail,
  type ContentProjectPage,
} from './organization-api';

/**
 * The content and run wire contract, read from the requests these functions
 * make and the bodies they accept.
 *
 * Every type in `organization-api.ts` for these families is now an alias of
 * the generated OpenAPI contract, which the Backend authors as Zod and
 * `apps/control-plane/test/unit/infrastructure/docs/content-contract.spec.ts` pins
 * from the producing side. These are the same payloads read from the
 * consuming one: a field the API stops sending fails to compile here, and a
 * URL, method or header that moves fails at runtime here.
 */

const ORGANIZATION = 'org_1';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const answers = (data: unknown, status = 200) => {
  fetchMock.mockResolvedValue(
    jsonResponse(
      { success: true, data, meta: { requestId: 'r', timestamp: 't' } },
      status,
    ),
  );
};

const requested = () => {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init };
};

const OPERATION: ContentIdeaOperation = {
  id: 'run_1',
  status: 'SUCCEEDED',
  output: {
    ideas: [
      {
        title: 'A title',
        hook: 'A hook',
        angle: 'An angle',
        summary: 'A summary',
        suggestedFormat: 'post',
      },
    ],
    sources: ['brand.voice'],
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:05.000Z',
};

const PROJECT: ContentProjectPage['items'][number] = {
  id: 'proj_1',
  organizationId: ORGANIZATION,
  sourceRunId: 'run_1',
  sourceIdeaIndex: 0,
  title: 'A title',
  hook: 'A hook',
  angle: 'An angle',
  summary: 'A summary',
  suggestedFormat: 'post',
  language: 'en',
  createdByUserId: 'user_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const DETAIL: ContentProjectDetail = {
  ...PROJECT,
  brief: { topic: 'A topic', goal: 'A goal', audience: null, guidance: null },
  drafts: [
    {
      id: 'draft_1',
      revision: 1,
      title: 'A title',
      format: 'post',
      language: 'en',
      body: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

describe('content idea availability', () => {
  it('reads the reason a disabled organization is given', async () => {
    answers({ available: false, reason: 'content_ideas_disabled' });

    await expect(
      getContentIdeaAvailability(ORGANIZATION),
    ).resolves.toEqual({ available: false, reason: 'content_ideas_disabled' });

    expect(requested().url).toBe(
      `${API_BASE_PATH}/organizations/${ORGANIZATION}/content-ideas/availability`,
    );
  });

  it('passes cancellation through to the request', async () => {
    answers({ available: true, reason: null });
    const controller = new AbortController();

    await getContentIdeaAvailability(ORGANIZATION, controller.signal);

    expect(requested().init.signal).toBe(controller.signal);
  });
});

describe('requesting ideas', () => {
  it('sends the brief and the caller idempotency key', async () => {
    answers(OPERATION, 201);

    await requestContentIdeas(
      ORGANIZATION,
      {
        topic: 'A topic',
        goal: 'A goal',
        language: 'en',
        numberOfIdeas: 5,
      },
      'idem-12345678',
    );

    const { url, init } = requested();

    expect(url).toBe(
      `${API_BASE_PATH}/organizations/${ORGANIZATION}/content-ideas`,
    );
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('idempotency-key')).toBe(
      'idem-12345678',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      topic: 'A topic',
      goal: 'A goal',
      language: 'en',
      numberOfIdeas: 5,
    });
  });

  it('accepts the 201 body as the same operation the read answers with', async () => {
    answers(OPERATION, 201);

    const accepted = await requestContentIdeas(
      ORGANIZATION,
      { topic: 'A topic', goal: 'A goal', language: 'en', numberOfIdeas: 5 },
      'idem-12345678',
    );

    fetchMock.mockReset();
    answers(OPERATION);

    // One held value carries the request from acceptance to a terminal state,
    // which only holds while both responses are the same shape.
    await expect(
      getContentIdeaOperation(ORGANIZATION, accepted.id),
    ).resolves.toEqual(accepted);
  });
});

describe('following a run', () => {
  it('reads a queued run that has produced nothing yet', async () => {
    answers({
      id: 'run_1',
      status: 'QUEUED',
      output: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
    });

    const operation = await getContentIdeaOperation(ORGANIZATION, 'run_1');

    expect(operation.status).toBe('QUEUED');
    expect(operation.output).toBeNull();
    expect(operation.completedAt).toBeNull();
    expect(requested().url).toBe(
      `${API_BASE_PATH}/organizations/${ORGANIZATION}/content-ideas/run_1`,
    );
  });

  it('reads a terminal failed run without an output', async () => {
    answers({
      id: 'run_1',
      status: 'FAILED',
      output: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:05.000Z',
    });

    const operation = await getContentIdeaOperation(ORGANIZATION, 'run_1');

    expect(operation.status).toBe('FAILED');
    expect(operation.output).toBeNull();
  });

  it('reads the ideas a succeeded run carries', async () => {
    answers(OPERATION);

    const operation = await getContentIdeaOperation(ORGANIZATION, 'run_1');

    expect(operation.output?.ideas).toHaveLength(1);
    expect(operation.output?.ideas[0].suggestedFormat).toBe('post');
    expect(operation.output?.sources).toEqual(['brand.voice']);
  });

  it('escapes an identifier rather than pasting it into the path', async () => {
    answers(OPERATION);

    await getContentIdeaOperation(ORGANIZATION, 'run 1/../other');

    expect(requested().url).toBe(
      `${API_BASE_PATH}/organizations/${ORGANIZATION}/content-ideas/run%201%2F..%2Fother`,
    );
  });
});

describe('the runtime vocabularies', () => {
  /*
   * These lists exist because the screen needs values, not just types. Each is
   * `satisfies` its generated union, so this only has to prove the lists are
   * still the whole vocabulary — the compiler already refuses a member the API
   * does not accept.
   */
  it.each([
    ['languages', CONTENT_IDEA_LANGUAGES, ['ar', 'en']],
    ['formats', CONTENT_IDEA_FORMATS, ['carousel', 'post', 'video']],
    [
      'statuses',
      CONTENT_IDEA_STATUSES,
      ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'],
    ],
    [
      'unavailable reasons',
      CONTENT_IDEA_UNAVAILABLE_REASONS,
      [
        'agents_disabled',
        'content_ideas_disabled',
        'agent_not_installed',
        'agent_disabled',
      ],
    ],
  ])('offers every %s the contract declares', (_what, offered, expected) => {
    expect([...offered]).toEqual(expected);
  });
});

describe('listing content projects', () => {
  it('asks for the first page with no query at all', async () => {
    answers({ items: [PROJECT], nextCursor: 'cursor_2' });

    await listContentProjects(ORGANIZATION);

    expect(requested().url).toBe(
      `${API_BASE_PATH}/organizations/${ORGANIZATION}/content-projects`,
    );
  });

  it('carries a cursor and a limit into the query when given them', async () => {
    answers({ items: [PROJECT], nextCursor: null });

    await listContentProjects(ORGANIZATION, {
      cursor: 'cursor_2',
      limit: 10,
    });

    expect(requested().url).toBe(
      `${API_BASE_PATH}/organizations/${ORGANIZATION}/content-projects?cursor=cursor_2&limit=10`,
    );
  });

  it('reads the final page as one with nothing after it', async () => {
    answers({ items: [PROJECT], nextCursor: null });

    const page = await listContentProjects(ORGANIZATION, {
      cursor: 'cursor_2',
    });

    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
  });

  it('passes cancellation through to the request', async () => {
    answers({ items: [], nextCursor: null });
    const controller = new AbortController();

    await listContentProjects(ORGANIZATION, {}, controller.signal);

    expect(requested().init.signal).toBe(controller.signal);
  });
});

describe('one content project', () => {
  it('reads the project with its brief and drafts', async () => {
    answers(DETAIL);

    const detail = await getContentProject(ORGANIZATION, 'proj_1');

    expect(detail.brief.topic).toBe('A topic');
    expect(detail.drafts[0].body).toBeNull();
    expect(requested().url).toBe(
      `${API_BASE_PATH}/organizations/${ORGANIZATION}/content-projects/proj_1`,
    );
  });

  it('promotes an idea with the selection and the idempotency key', async () => {
    answers(DETAIL, 201);

    await createContentProjectFromIdea(
      ORGANIZATION,
      { sourceRunId: 'run_1', ideaIndex: 0 },
      'idem-12345678',
    );

    const { url, init } = requested();

    expect(url).toBe(
      `${API_BASE_PATH}/organizations/${ORGANIZATION}/content-projects/from-idea`,
    );
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('idempotency-key')).toBe(
      'idem-12345678',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      sourceRunId: 'run_1',
      ideaIndex: 0,
    });
  });
});

describe('a refused content request', () => {
  /*
   * Generating these payloads changes nothing about how a failure is read:
   * the shared EH-01 decoder still owns `error.details`, and these families
   * do not get an error contract of their own.
   */
  it('reads a validation refusal through the shared decoder', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
            details: {
              kind: 'validation',
              fields: [
                { field: 'topic', code: 'TOO_SMALL', message: 'Too short' },
              ],
              messages: [],
            },
          },
        },
        400,
      ),
    );

    const thrown = await requestContentIdeas(
      ORGANIZATION,
      { topic: 'a', goal: 'A goal', language: 'en', numberOfIdeas: 5 },
      'idem-12345678',
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ApiError);
    const error = thrown as ApiError;

    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(errorDetailLines(error.details)).toEqual(['Too short']);
  });

  it('reads a business refusal without turning it into field errors', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'CONFLICT',
            message: 'Conflict',
            details: {
              kind: 'business',
              reason: 'Ideas can only be selected from a request that succeeded.',
            },
          },
        },
        409,
      ),
    );

    const thrown = await createContentProjectFromIdea(
      ORGANIZATION,
      { sourceRunId: 'run_1', ideaIndex: 0 },
      'idem-12345678',
    ).catch((error: unknown) => error);

    const error = thrown as ApiError;

    expect(error.status).toBe(409);
    expect(error.details.kind).toBe('business');
    expect(errorDetailLines(error.details)).toEqual([
      'Ideas can only be selected from a request that succeeded.',
    ]);
  });

  it('does not throw a parser error on a body that is not JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>502</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const thrown = await listContentProjects(ORGANIZATION).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(ApiError);
    // The HTTP context survives a body the decoder cannot read.
    expect((thrown as ApiError).status).toBe(502);
  });
});
