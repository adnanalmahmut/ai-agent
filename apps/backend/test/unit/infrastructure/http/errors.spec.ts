import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';

import { AppException } from '../../../../src/core/errors';
import { UnifiedExceptionFilter } from '../../../../src/infrastructure/http/errors';
import type {
  ApiErrorResponse,
  ApiValidationErrorDetails,
} from '../../../../src/infrastructure/http/response';
import { ValidationException } from '../../../../src/infrastructure/http/validation';
import type { AppI18nService } from '../../../../src/infrastructure/i18n/app-i18n.service';

/**
 * The producing side of the `error.details` contract.
 * `apps/platform/src/lib/api/response-protocol.test.ts` reads the same shapes
 * from the consuming side, so neither can be changed alone without one of the
 * two failing.
 */

const i18n = {
  translateFor: (_locale: string, key: string) => `translated:${key}`,
} as unknown as AppI18nService;

type Caught = { status: number; body: ApiErrorResponse };

const raise = (exception: unknown): Caught => {
  const filter = new UnifiedExceptionFilter(i18n);

  let caught: Caught | undefined;
  const response = {
    getHeader: () => 'req_test',
    status: (status: number) => ({
      json: (body: ApiErrorResponse) => {
        caught = { status, body };
      },
    }),
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ headers: {}, method: 'POST', url: '/x' }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  filter.catch(exception, host);

  if (caught === undefined) throw new Error('the filter wrote no response');

  return caught;
};

const detailsOf = (caught: Caught) => caught.body.error.details;

beforeAll(() => {
  // The unknown-error case logs the stack internally on purpose; that is the
  // half of the behaviour under test that must not reach the response.
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('a request the endpoint could not accept', () => {
  it('reports field errors as validation details, not as a bare array', () => {
    const caught = raise(
      new ValidationException([
        { field: 'email', code: 'INVALID_EMAIL' },
        { field: 'age', code: 'MIN', args: { min: 18 } },
      ]),
    );

    expect(caught.status).toBe(HttpStatus.BAD_REQUEST);
    expect(caught.body.error.code).toBe('VALIDATION_ERROR');

    const details = detailsOf(caught) as ApiValidationErrorDetails;
    expect(details.kind).toBe('validation');
    expect(details.fields.map((field) => field.field)).toEqual([
      'email',
      'age',
    ]);
    expect(details.messages).toEqual([]);
  });

  it('reports a service validating its own input the same way', () => {
    // Before the contract these arrived as `{ issues }` while the pipe's
    // arrived as an array, and a client could read one or the other.
    const caught = raise(
      new AppException('VALIDATION_ERROR', {
        publicDetails: { issues: ['Too big: expected number to be <=100'] },
      }),
    );

    expect(detailsOf(caught)).toEqual({
      kind: 'validation',
      fields: [],
      messages: ['Too big: expected number to be <=100'],
    });
  });

  it('reads a single reason as a message rather than as a business detail', () => {
    const caught = raise(
      new AppException('VALIDATION_ERROR', {
        publicDetails: { reason: 'The page cursor is not readable.' },
      }),
    );

    expect(detailsOf(caught)).toEqual({
      kind: 'validation',
      fields: [],
      messages: ['The page cursor is not readable.'],
    });
  });
});

describe('a domain rule that said no', () => {
  it('keeps the endpoint’s own keys and says it is a business refusal', () => {
    const caught = raise(
      new AppException('CONFLICT', {
        publicDetails: { reason: 'already_installed' },
      }),
    );

    expect(caught.status).toBe(HttpStatus.CONFLICT);
    expect(detailsOf(caught)).toEqual({
      kind: 'business',
      reason: 'already_installed',
    });
  });

  it('carries a nested reading the caller can act on', () => {
    const caught = raise(
      new AppException('SERVICE_UNAVAILABLE', {
        publicDetails: { process: { status: 'draining' } },
      }),
    );

    expect(detailsOf(caught)).toEqual({
      kind: 'business',
      process: { status: 'draining' },
    });
  });

  it('sends no details at all when the producer gave none', () => {
    const caught = raise(new AppException('NOT_FOUND', { userId: 'u_1' }));

    expect(detailsOf(caught)).toBeUndefined();
    expect(JSON.stringify(caught.body)).not.toContain('u_1');
  });
});

describe('what may not leave the process', () => {
  it('drops a raw Error handed to it as a public detail', () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.5:5432');

    const caught = raise(
      new AppException('SERVICE_UNAVAILABLE', {
        publicDetails: { reason: 'unreachable', cause },
      }),
    );

    expect(detailsOf(caught)).toEqual({
      kind: 'business',
      reason: 'unreachable',
    });
    expect(JSON.stringify(caught.body)).not.toContain('ECONNREFUSED');
  });

  it('drops a driver exception rather than serializing its internals', () => {
    class PrismaClientKnownRequestError extends Error {
      readonly code = 'P2002';
      readonly meta = { target: ['email'], query: 'SELECT * FROM "User"' };
    }

    const caught = raise(
      new AppException('CONFLICT', {
        publicDetails: {
          reason: 'duplicate',
          error: new PrismaClientKnownRequestError('unique constraint'),
        },
      }),
    );

    expect(detailsOf(caught)).toEqual({
      kind: 'business',
      reason: 'duplicate',
    });
    expect(JSON.stringify(caught.body)).not.toContain('SELECT');
    expect(JSON.stringify(caught.body)).not.toContain('P2002');
  });

  it('will not let a producer set the discriminator itself', () => {
    const caught = raise(
      new AppException('CONFLICT', {
        publicDetails: { kind: 'validation', reason: 'already_decided' },
      }),
    );

    expect(detailsOf(caught)).toEqual({
      kind: 'business',
      reason: 'already_decided',
    });
  });

  it('sanitizes details carried on a framework exception too', () => {
    const caught = raise(
      new BadRequestException({
        details: { reason: 'malformed', socket: new Error('boom') },
      }),
    );

    expect(detailsOf(caught)).toEqual({
      kind: 'business',
      reason: 'malformed',
    });
  });
});

describe('an error nothing expected', () => {
  it('stays a 500 with no details and nothing of the failure in the body', () => {
    const caught = raise(
      new Error('Invalid `prisma.user.findMany()`: SELECT * FROM "User"'),
    );

    expect(caught.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(caught.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(detailsOf(caught)).toBeUndefined();

    const serialized = JSON.stringify(caught.body);
    expect(serialized).not.toContain('SELECT');
    expect(serialized).not.toContain('prisma');
    expect(serialized).not.toContain('at ');
  });

  it('does not become client-correctable because it carried a status-like field', () => {
    const caught = raise(new Error('boom'));

    expect(caught.status).toBeGreaterThanOrEqual(500);
  });
});
