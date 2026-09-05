import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_PATH } from '@/config/paths';
import { ApiError, ApiUnavailableError } from '@/lib/application-api';

/**
 * The server transport is the same protocol read from the other side of the
 * application: no browser credentials, a forwarded cookie, and an anonymous
 * request that is allowed to come back empty. These tests state that reading
 * alongside the browser's in `application-api.test.ts`, so a change to the
 * shared interpretation cannot quietly hold for one side and not the other.
 */

const API_ORIGIN = 'http://api.test';

vi.mock('server-only', () => ({}));
vi.mock('@/config/server', () => ({
  serverConfig: { apiOrigin: API_ORIGIN },
}));

const requestHeaders = new Headers();

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(requestHeaders),
}));

const { serverApiRequest } = await import('./server-request');

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  requestHeaders.delete('cookie');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const enveloped = (data: unknown) =>
  jsonResponse({
    success: true,
    data,
    meta: { requestId: 'req_test', timestamp: '2026-08-23T00:00:00.000Z' },
  });

const failure = async (response: Response) => {
  fetchMock.mockResolvedValue(response);

  return (await serverApiRequest('/x').catch((e: unknown) => e)) as ApiError;
};

describe('a server-rendered call', () => {
  it('addresses the API origin, uncached', async () => {
    fetchMock.mockResolvedValue(enveloped([]));

    await serverApiRequest('/organizations');

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_ORIGIN}${API_BASE_PATH}/organizations`,
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('forwards the caller’s cookie when the request carried one', async () => {
    requestHeaders.set('cookie', 'session=abc');
    fetchMock.mockResolvedValue(enveloped([]));

    await serverApiRequest('/organizations');

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { cookie: 'session=abc' },
    });
  });

  it('sends no headers at all when the request carried no cookie', async () => {
    fetchMock.mockResolvedValue(enveloped([]));

    await serverApiRequest('/organizations');

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: undefined });
  });

  it('returns what the server put in the envelope, not the envelope', async () => {
    fetchMock.mockResolvedValue(enveloped([{ id: 'org_1' }]));

    await expect(serverApiRequest('/organizations')).resolves.toEqual([
      { id: 'org_1' },
    ]);
  });

  it('unwraps an object payload as readily as a list', async () => {
    fetchMock.mockResolvedValue(enveloped({ key: 'agents.enabled' }));

    await expect(serverApiRequest('/x')).resolves.toEqual({
      key: 'agents.enabled',
    });
  });

  it('returns an unenveloped body as it stands', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));

    await expect(serverApiRequest('/health')).resolves.toEqual({
      status: 'ok',
    });
  });
});

describe('a server-rendered refusal', () => {
  it('carries the status and the machine-readable code', async () => {
    const thrown = await failure(
      jsonResponse({ code: 'ORGANIZATION_NOT_ARCHIVED' }, 409),
    );

    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({
      status: 409,
      code: 'ORGANIZATION_NOT_ARCHIVED',
    });
  });

  it('reads a code nested under `error`', async () => {
    const thrown = await failure(
      jsonResponse({ error: { code: 'FORBIDDEN' } }, 403),
    );

    expect(thrown.code).toBe('FORBIDDEN');
    expect(thrown.details).toEqual({});
  });

  it('reads the issues a validation failure listed', async () => {
    const thrown = await failure(
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_ERROR',
            details: { issues: ['Too big: expected number to be <=100'] },
          },
        },
        422,
      ),
    );

    expect(thrown.code).toBe('VALIDATION_ERROR');
    expect(thrown.details.issues).toEqual([
      'Too big: expected number to be <=100',
    ]);
  });

  it('reads a single reason from an unnested body', async () => {
    const thrown = await failure(
      jsonResponse(
        { code: 'VALIDATION_ERROR', details: { reason: 'no' } },
        422,
      ),
    );

    expect(thrown.details.reason).toBe('no');
  });

  it('refuses details that are not the shape the interface shows', async () => {
    const thrown = await failure(
      jsonResponse(
        {
          error: {
            details: { issues: ['ok', { bad: 1 }], reason: { text: 'no' } },
          },
        },
        422,
      ),
    );

    expect(thrown.details).toEqual({});
  });

  it('survives a body that is not JSON at all', async () => {
    const thrown = await failure(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown.status).toBe(502);
    expect(thrown.code).toBeUndefined();
    expect(thrown.details).toEqual({});
  });

  it('never puts the server’s message into the thrown error', async () => {
    const thrown = await failure(
      jsonResponse({ code: 'FORBIDDEN', message: 'Nope, sunshine' }, 403),
    );

    expect(thrown.message).not.toContain('sunshine');
  });
});

describe('a page that may be read anonymously', () => {
  it('reads an unauthenticated refusal as no session rather than a failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'UNAUTHORIZED' }, 401));

    await expect(
      serverApiRequest('/user/session', { allowAnonymous: true }),
    ).resolves.toBeNull();
  });

  it('still refuses when the page did not allow anonymity', async () => {
    const thrown = await failure(jsonResponse({ code: 'UNAUTHORIZED' }, 401));

    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown.status).toBe(401);
  });

  it('lets any other refusal through even when anonymity is allowed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'FORBIDDEN' }, 403));

    await expect(
      serverApiRequest('/user/session', { allowAnonymous: true }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('a server-rendered request that never arrived', () => {
  it('is a different kind of failure from a refusal', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(serverApiRequest('/x')).rejects.toBeInstanceOf(
      ApiUnavailableError,
    );
  });

  it('keeps the original as its cause, without rendering it', async () => {
    const cause = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(cause);

    const thrown = (await serverApiRequest('/x').catch(
      (e: unknown) => e,
    )) as ApiUnavailableError;

    expect(thrown.cause).toBe(cause);
    expect(thrown.message).not.toContain('Failed to fetch');
  });
});

describe('an empty server-rendered success', () => {
  it('resolves to nothing rather than failing to parse nothing', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(serverApiRequest('/x')).resolves.toBeNull();
  });
});
