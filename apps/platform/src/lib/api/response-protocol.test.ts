import { describe, expect, it } from 'vitest';

import {
  errorDetailLines,
  readApiError,
  unwrapEnvelope,
  type ApiErrorDetails,
} from './response-protocol';

/**
 * The wire contract for `error.details`, read from the bodies the API actually
 * sends. The backend's `UnifiedExceptionFilter` writes these shapes and
 * `apps/backend/test/unit/infrastructure/http/errors.spec.ts` pins them from
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

  it('carries no reason when the refusal named none', async () => {
    const read = await details(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          details: { kind: 'business', process: { status: 'draining' } },
        },
      },
      503,
    );

    expect(read).toEqual({ kind: 'business' });
    expect(errorDetailLines(read)).toEqual([]);
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
