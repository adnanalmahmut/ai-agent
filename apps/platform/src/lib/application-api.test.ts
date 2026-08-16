import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_PATH } from '@/config/paths';

import { ApiError, ApiUnavailableError, apiRequest } from './application-api';

/**
 * The one place this application calls a NestJS route.
 *
 * Worth its own tests because everything it gets wrong is invisible at the
 * call site: a missing credentials mode looks like a permission bug, a
 * swallowed error code looks like a translation bug, and an HTML error body
 * from a gateway looks like a crash.
 */
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

describe('a successful call', () => {
  it('addresses the API by path on this same origin', async () => {
    // No host anywhere: production and development both serve the backend
    // from `/api` on the origin the page came from.
    fetchMock.mockResolvedValue(jsonResponse([]));

    await apiRequest('/organizations/archived');

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_PATH}/organizations/archived`,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('returns the parsed body', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: 'org_1' }]));

    await expect(apiRequest('/organizations/archived')).resolves.toEqual([
      { id: 'org_1' },
    ]);
  });

  it('sends JSON only when there is a body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await apiRequest('/organizations/org_1/restore', { method: 'POST' });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: undefined,
      body: undefined,
    });
  });

  it('serializes a body it was given', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await apiRequest('/organizations/org_1/archive', {
      method: 'POST',
      body: { reason: 'wound down' },
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'content-type': 'application/json' },
      body: '{"reason":"wound down"}',
    });
  });
});

describe('a refusal', () => {
  it('carries the status and the machine-readable code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ errorCode: 'x', code: 'ORGANIZATION_NOT_ARCHIVED' }, 409),
    );

    await expect(apiRequest('/organizations/org_1/restore')).rejects.toMatchObject(
      { status: 409, code: 'ORGANIZATION_NOT_ARCHIVED' },
    );
  });

  it('reads a code nested under `error`', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN' } }, 403),
    );

    await expect(apiRequest('/x')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('survives a body that is not JSON at all', async () => {
    // A gateway that never reached Nest returns HTML. That must not turn a
    // 502 into a parse exception on the way to an error message.
    fetchMock.mockResolvedValue(
      new Response('<html>bad gateway</html>', { status: 502 }),
    );

    const failure = await apiRequest('/x').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(502);
    expect((failure as ApiError).code).toBeUndefined();
  });

  it('never puts the server’s message into the thrown error', async () => {
    // The UI renders its own copy in the reader's language; surfacing a
    // server-chosen sentence would mean two sources of truth for one screen.
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'FORBIDDEN', message: 'Nope, sunshine' }, 403),
    );

    const failure = (await apiRequest('/x').catch((e: unknown) => e)) as ApiError;

    expect(failure.message).not.toContain('sunshine');
  });
});

describe('a request that never arrived', () => {
  it('is a different kind of failure from a refusal', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiRequest('/x')).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  it('keeps the original as its cause, without rendering it', async () => {
    const cause = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(cause);

    const failure = (await apiRequest('/x').catch(
      (e: unknown) => e,
    )) as ApiUnavailableError;

    expect(failure.cause).toBe(cause);
    expect(failure.message).not.toContain('Failed to fetch');
  });
});

describe('an empty success', () => {
  it('resolves rather than failing to parse nothing', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(apiRequest('/x', { method: 'POST' })).resolves.toBeUndefined();
  });
});
