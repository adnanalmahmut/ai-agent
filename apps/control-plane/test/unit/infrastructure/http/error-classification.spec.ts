import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';

import { InvariantViolationError } from '../../../../src/core/errors';
import { Prisma } from '../../../../src/generated/prisma/client';
import { UnifiedExceptionFilter } from '../../../../src/infrastructure/http/errors';
import { QueuePublishError } from '../../../../src/infrastructure/queue/queue-publish.error';
import type { ApiErrorResponse } from '../../../../src/infrastructure/http/response';
import type { AppI18nService } from '../../../../src/infrastructure/i18n/app-i18n.service';

/**
 * Which failures may be answered as the caller's fault.
 *
 * A bug, a state that was supposed to be impossible, and a driver error nobody
 * mapped are all the same answer: 500, logged, redacted. Turning one of them
 * into a 4xx would tell a caller to fix something they cannot fix and would
 * take the failure off the list of things anybody looks at.
 */

const i18n = {
  translateFor: (_locale: string, key: string) => `translated:${key}`,
} as unknown as AppI18nService;

type Caught = { status: number; body: ApiErrorResponse };

const raise = (exception: unknown): Caught => {
  const filter = new UnifiedExceptionFilter(i18n);

  let caught: Caught | undefined;
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ headers: {}, method: 'POST', url: '/x' }),
      getResponse: () => ({
        getHeader: () => 'req_test',
        status: (status: number) => ({
          json: (body: ApiErrorResponse) => {
            caught = { status, body };
          },
        }),
      }),
    }),
  } as unknown as ArgumentsHost;

  filter.catch(exception, host);

  if (caught === undefined) throw new Error('the filter wrote no response');

  return caught;
};

const isInternalAndSilent = (caught: Caught, ...secrets: string[]) => {
  expect(caught.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  expect(caught.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  expect(caught.body.error.details).toBeUndefined();

  const serialized = JSON.stringify(caught.body);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
};

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('a state that was supposed to be impossible', () => {
  it('stays an internal failure rather than becoming the caller’s problem', () => {
    const caught = raise(
      new InvariantViolationError(
        'Organization agent installation has no active version',
      ),
    );

    isInternalAndSilent(caught, 'active version', 'Invariant');
    expect(caught.status).not.toBe(HttpStatus.NOT_FOUND);
    expect(caught.status).not.toBe(HttpStatus.CONFLICT);
  });

  it('is logged so that it is on somebody’s list', () => {
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    raise(new InvariantViolationError('no active version'));

    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]?.[0])).toContain('Invariant violated');
  });
});

describe('a driver error nobody mapped', () => {
  it.each(['P2003', 'P2025', 'P2010'])(
    'answers %s with a redacted 500 rather than guessing a 4xx',
    (code) => {
      const caught = raise(
        new Prisma.PrismaClientKnownRequestError(
          'Foreign key constraint failed on the field: `organizationId`',
          {
            code,
            clientVersion: 'test',
            meta: { field_name: 'organizationId' },
          },
        ),
      );

      isInternalAndSilent(caught, code, 'organizationId', 'constraint');
      expect(caught.status).toBeGreaterThanOrEqual(500);
    },
  );
});

describe('a publish that did not reach the queue', () => {
  // This does not reach an HTTP response today: it is produced inside the
  // queue producer and handled by the outbox dispatcher, whose retry and
  // terminal behaviour is unchanged here. The case is pinned so that nothing
  // later starts answering a caller 503 for work the outbox already accepted
  // durably -- that would tell them to retry a request that was not lost.
  it('is not answered as a service the caller should retry', () => {
    const caught = raise(
      new QueuePublishError(
        'agent-runs',
        'timeout',
        'redis timed out at 10.0.0.5:6379',
      ),
    );

    isInternalAndSilent(caught, '10.0.0.5', 'agent-runs');
    expect(caught.status).not.toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('keeps classifying its own failures for the dispatcher', () => {
    expect(new QueuePublishError('q', 'timeout', 'took too long').kind).toBe(
      'transient',
    );
    expect(
      new QueuePublishError('q', 'rejected', 'exceeds the limit of 1 bytes')
        .kind,
    ).toBe('permanent');
    expect(new QueuePublishError('q', 'rejected', 'redis said no').kind).toBe(
      'transient',
    );
  });
});

describe('an ordinary programming error', () => {
  it('is still a redacted 500', () => {
    isInternalAndSilent(
      raise(
        new TypeError("Cannot read properties of undefined (reading 'id')"),
      ),
      'Cannot read properties',
    );
  });
});
