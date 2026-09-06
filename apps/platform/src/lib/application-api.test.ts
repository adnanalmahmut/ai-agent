import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_PATH } from '@/config/paths';

import {
  ApiError,
  ApiUnavailableError,
  apiRequest,
  errorDetailLines,
} from './application-api';

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

const enveloped = (data: unknown, status = 200) =>
  jsonResponse(
    {
      success: true,
      data,
      meta: { requestId: 'req_test', timestamp: '2026-08-23T00:00:00.000Z' },
    },
    status,
  );

describe('a successful call', () => {
  it('addresses the API by path on this same origin', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await apiRequest('/organizations/archived');

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_PATH}/organizations/archived`,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('returns what the server put in the envelope, not the envelope', async () => {
    fetchMock.mockResolvedValue(enveloped([{ id: 'org_1' }]));

    await expect(apiRequest('/organizations/archived')).resolves.toEqual([
      { id: 'org_1' },
    ]);
  });

  it('unwraps an object payload as readily as a list', async () => {
    fetchMock.mockResolvedValue(enveloped({ key: 'agents.enabled' }));

    await expect(apiRequest('/x')).resolves.toEqual({ key: 'agents.enabled' });
  });

  it('drops the envelope metadata rather than returning a pair', async () => {
    fetchMock.mockResolvedValue(enveloped(['a']));

    const result = await apiRequest<string[]>('/x');

    expect(result).toEqual(['a']);
    expect(result).not.toHaveProperty('meta');
  });

  it('returns an unenveloped body as it stands', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));

    await expect(apiRequest('/health')).resolves.toEqual({ status: 'ok' });
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

  it('sends a caller header alongside the JSON header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await apiRequest('/organizations/org_1/content-ideas', {
      method: 'POST',
      body: { topic: 'Kettles' },
      headers: { 'idempotency-key': 'key-1234' },
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'key-1234',
      },
    });
  });

  it('sends a caller header on a request with no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await apiRequest('/organizations/org_1/content-ideas', {
      headers: { 'idempotency-key': 'key-1234' },
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'idempotency-key': 'key-1234' },
    });
    expect(
      (fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)[
        'content-type'
      ],
    ).toBeUndefined();
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

    await expect(
      apiRequest('/organizations/org_1/restore'),
    ).rejects.toMatchObject({ status: 409, code: 'ORGANIZATION_NOT_ARCHIVED' });
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
    fetchMock.mockResolvedValue(
      new Response('<html>bad gateway</html>', { status: 502 }),
    );

    const failure = await apiRequest('/x').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(502);
    expect((failure as ApiError).code).toBeUndefined();
  });

  it('never puts the server’s message into the thrown error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'FORBIDDEN', message: 'Nope, sunshine' }, 403),
    );

    const failure = (await apiRequest('/x').catch(
      (e: unknown) => e,
    )) as ApiError;

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

describe('the reasons a refusal carries', () => {
  it('keeps the field errors a validation failure listed', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_ERROR',
            details: {
              kind: 'validation',
              fields: [
                {
                  field: 'email',
                  code: 'INVALID_EMAIL',
                  message: 'Not an email',
                },
              ],
              messages: [],
            },
          },
        },
        400,
      ),
    );

    const failure = (await apiRequest('/x').catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(failure.code).toBe('VALIDATION_ERROR');
    expect(errorDetailLines(failure.details)).toEqual(['Not an email']);
  });

  it('reads a refusal from an unnested body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { code: 'CONFLICT', details: { kind: 'business', reason: 'no' } },
        409,
      ),
    );

    const failure = (await apiRequest('/x').catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(failure.details).toEqual({ kind: 'business', reason: 'no' });
  });

  it('refuses messages that are not all strings', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            details: {
              kind: 'validation',
              fields: [],
              messages: ['ok', { bad: 1 }],
            },
          },
        },
        422,
      ),
    );

    const failure = (await apiRequest('/x').catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(errorDetailLines(failure.details)).toEqual([]);
  });

  it('refuses a reason that is not a string', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { details: { reason: { text: 'no' } } } }, 422),
    );

    const failure = (await apiRequest('/x').catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(failure.details).toEqual({ kind: 'none' });
  });

  it('carries no details when the body has none', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN' } }, 403),
    );

    const failure = (await apiRequest('/x').catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(failure.code).toBe('FORBIDDEN');
    expect(failure.details).toEqual({ kind: 'none' });
  });

  it('survives an error body that is not JSON at all', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const failure = (await apiRequest('/x').catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.details).toEqual({ kind: 'none' });
  });
});
