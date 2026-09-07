import { describe, expect, it } from 'vitest';

import {
  errorDetailLines,
  readApiError,
  unwrapEnvelope,
  type ApiErrorDetails,
} from '@repo/api-client';

/**
 * The wire contract for `error.details`, read from the bodies the API actually
 * sends. The implementation lives in `@repo/api-client`; the tests stay in the
 * application suite because that is the runner this repository already has,
 * and they exercise the package's own code either way. The backend's `UnifiedExceptionFilter` writes these shapes and
 * `apps/control-plane/test/unit/infrastructure/http/errors.spec.ts` pins them from
 * the producing side; this is the same contract read from the consuming one,
 * so a change to either without the other fails on one side or the other.
 */

const jsonResponse = (body: unknown, status = 400) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const details = async (body: unknown, status = 400): Promise<ApiErrorDetails> =>
  (await readApiError(jsonResponse(body, status))).details;

describe('a validated request that was refused', () => {
  it('keeps every field error the server sent', async () => {
    const read = await details({
      error: {
        code: 'VALIDATION_ERROR',
        details: {
          kind: 'validation',
          fields: [
            { field: 'email', code: 'INVALID_EMAIL', message: 'Not an email' },
            { field: 'age', code: 'MIN', message: 'Must be at least 18' },
          ],
          messages: [],
        },
      },
    });

    expect(read).toEqual({
      kind: 'validation',
      fields: [
        { field: 'email', code: 'INVALID_EMAIL', message: 'Not an email' },
        { field: 'age', code: 'MIN', message: 'Must be at least 18' },
      ],
      messages: [],
    });
    expect(errorDetailLines(read)).toEqual([
      'Not an email',
      'Must be at least 18',
    ]);
  });

  it('keeps the reasons that belong to no single field', async () => {
    const read = await details({
      error: {
        code: 'VALIDATION_ERROR',
        details: {
          kind: 'validation',
          fields: [],
          messages: ['Too big: expected number to be <=100'],
        },
      },
    });

    expect(errorDetailLines(read)).toEqual([
      'Too big: expected number to be <=100',
    ]);
  });

  it('is never mistaken for a business refusal', async () => {
    const read = await details({
      error: {
        code: 'VALIDATION_ERROR',
        details: { kind: 'validation', fields: [], messages: ['nope'] },
      },
    });

    expect(read.kind).toBe('validation');
  });
});

describe('a business rule that said no', () => {
  it('is read as a refusal and not as field errors', async () => {
    const read = await details(
      {
        error: {
          code: 'CONFLICT',
          details: { kind: 'business', reason: 'already_installed' },
        },
      },
      409,
    );

    expect(read).toEqual({ kind: 'business', reason: 'already_installed' });
    expect(errorDetailLines(read)).toEqual(['already_installed']);
  });

  it('keeps the metadata a refusal carried instead of only its reason', async () => {
    // The readiness probe answers with a dependency map and no reason at all.
    // Dropping it left a screen with a generic sentence and nothing to show.
    const read = await details(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          details: { kind: 'business', process: { status: 'draining' } },
        },
      },
      503,
    );

    expect(read).toEqual({
      kind: 'business',
      process: { status: 'draining' },
    });
    expect(errorDetailLines(read)).toEqual([]);
  });

  it('keeps a reason alongside the rest rather than instead of it', async () => {
    const read = await details(
      {
        error: {
          code: 'TOO_MANY_REQUESTS',
          details: { kind: 'business', reason: 'rate_limited', retryAfterSec: 30 },
        },
      },
      429,
    );

    expect(read).toEqual({
      kind: 'business',
      reason: 'rate_limited',
      retryAfterSec: 30,
    });
    expect(errorDetailLines(read)).toEqual(['rate_limited']);
  });

  it('keeps a refusal that carried nothing but a reason', async () => {
    const read = await details(
      { error: { code: 'CONFLICT', details: { kind: 'business', reason: 'x' } } },
      409,
    );

    expect(read).toEqual({ kind: 'business', reason: 'x' });
  });

  it('keeps safe scalars and arrays, at any of the depths the API sends', async () => {
    const read = await details(
      {
        error: {
          code: 'CONFLICT',
          details: {
            kind: 'business',
            attempted: 3,
            allowed: false,
            missing: null,
            conflicts: ['a', 'b'],
            limits: { window: { seconds: 60, max: 5 } },
          },
        },
      },
      409,
    );

    expect(read).toEqual({
      kind: 'business',
      attempted: 3,
      allowed: false,
      missing: null,
      conflicts: ['a', 'b'],
      limits: { window: { seconds: 60, max: 5 } },
    });
  });

  it('reads the same keys the API declares it may send', async () => {
    // The producing side is pinned in
    // apps/control-plane/test/unit/infrastructure/http/errors.spec.ts; this is the
    // same document read back, so neither side can quietly narrow the other.
    const read = await details(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          details: {
            kind: 'business',
            postgres: { status: 'down' },
            redis: { status: 'up' },
          },
        },
      },
      503,
    );

    expect(Object.keys(read).sort()).toEqual(['kind', 'postgres', 'redis']);
  });
});

describe('what a refusal is not allowed to smuggle in', () => {
  // Read without a JSON round trip on the way in. `response.json()` would
  // flatten these to whatever survives serialization, which is not the
  // question: the decoder is also handed objects in-process, and the rule it
  // applies has to be its own rather than a side effect of the transport.
  const readDirect = async (value: unknown): Promise<ApiErrorDetails> => {
    const response = {
      json: () =>
        Promise.resolve({ error: { code: 'CONFLICT', details: value } }),
    } as unknown as Response;

    return (await readApiError(response)).details;
  };

  it('drops a value that is not JSON', async () => {
    const read = await readDirect({
      kind: 'business',
      reason: 'unreachable',
      cause: new Error('connect ECONNREFUSED 10.0.0.5:5432'),
      retry: () => undefined,
    });

    expect(read).toEqual({ kind: 'business', reason: 'unreachable' });
  });

  it('drops a class instance rather than reading its fields', async () => {
    class DriverError extends Error {
      readonly code = 'P2002';
      readonly meta = { query: 'SELECT * FROM "User"' };
    }

    const read = await readDirect({
      kind: 'business',
      reason: 'duplicate',
      error: new DriverError('unique constraint'),
    });

    expect(read).toEqual({ kind: 'business', reason: 'duplicate' });
    expect(JSON.stringify(read)).not.toContain('SELECT');
  });

  it('stops descending before an unbounded graph does', async () => {
    const read = (await readDirect({
      kind: 'business',
      a: { b: { c: { d: { shown: 'kept', e: { f: 'too deep' } } } } },
    })) as Record<string, unknown>;

    // The same bound the API applies on the way out, so a document that
    // survived one side is never truncated only by the other.
    expect(read).toEqual({
      kind: 'business',
      a: { b: { c: { d: { shown: 'kept' } } } },
    });
    expect(JSON.stringify(read)).not.toContain('too deep');
  });

  it('drops a reason the wire made something other than a sentence', async () => {
    const read = await readDirect({ kind: 'business', reason: { text: 'no' } });

    expect(read).toEqual({ kind: 'business' });
    expect(errorDetailLines(read)).toEqual([]);
  });

  it('reads malformed business details without throwing', async () => {
    await expect(readDirect({ kind: 'business' })).resolves.toEqual({
      kind: 'business',
    });
    await expect(
      readDirect({ kind: 'business', nested: undefined }),
    ).resolves.toEqual({ kind: 'business' });
  });
});

describe('the shapes an older release still sends', () => {
  // A rollback to a release published before the contract was declared is a
  // supported operation, and the running interface has to survive one.
  it('reads a bare array of field errors as the validation failure it was', async () => {
    const read = await details({
      error: {
        code: 'VALIDATION_ERROR',
        details: [
          { field: 'email', code: 'INVALID_EMAIL', message: 'Not an email' },
        ],
      },
    });

    expect(read).toEqual({
      kind: 'validation',
      fields: [
        { field: 'email', code: 'INVALID_EMAIL', message: 'Not an email' },
      ],
      messages: [],
    });
  });

  it('reads an untagged `issues` list as validation messages', async () => {
    const read = await details({
      error: { code: 'VALIDATION_ERROR', details: { issues: ['too big'] } },
    });

    expect(read).toEqual({ kind: 'validation', fields: [], messages: ['too big'] });
  });

  it('reads an untagged `reason` as a business refusal', async () => {
    const read = await details({
      error: { code: 'CONFLICT', details: { reason: 'already_decided' } },
    });

    expect(read).toEqual({ kind: 'business', reason: 'already_decided' });
  });
});

describe('a body the interface cannot act on', () => {
  it('reads details that are not the declared shape as none', async () => {
    expect(await details({ error: { details: { reason: { text: 'no' } } } })).toEqual({
      kind: 'none',
    });
  });

  it('refuses a message list that is not all strings', async () => {
    const read = await details({
      error: {
        details: { kind: 'validation', fields: [], messages: ['ok', { bad: 1 }] },
      },
    });

    expect(errorDetailLines(read)).toEqual([]);
  });

  it('refuses a field list that is not all field errors', async () => {
    const read = await details({
      error: {
        details: {
          kind: 'validation',
          fields: [{ field: 'email' }],
          messages: [],
        },
      },
    });

    expect(read).toEqual({ kind: 'validation', fields: [], messages: [] });
  });

  it('survives a malformed body without losing the status', async () => {
    const response = new Response('{"error":', {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });

    await expect(readApiError(response)).resolves.toEqual({
      code: undefined,
      details: { kind: 'none' },
    });
    expect(response.status).toBe(422);
  });

  it('survives a body that is not JSON at all', async () => {
    const response = new Response('<html>502 Bad Gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });

    await expect(readApiError(response)).resolves.toEqual({
      code: undefined,
      details: { kind: 'none' },
    });
  });

  it('reads an unknown internal failure as a bare 500', async () => {
    const response = jsonResponse(
      {
        success: false,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal error' },
        meta: { requestId: 'req_1', timestamp: '2026-09-06T00:00:00.000Z' },
      },
      500,
    );

    await expect(readApiError(response)).resolves.toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      details: { kind: 'none' },
    });
  });
});

describe('the success envelope', () => {
  it('is still unwrapped to the payload the server sent', () => {
    expect(
      unwrapEnvelope({ success: true, data: [1, 2], meta: {} }),
    ).toEqual([1, 2]);
  });
});
