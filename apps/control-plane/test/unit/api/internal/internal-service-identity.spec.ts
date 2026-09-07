import { createHash } from 'node:crypto';

import { describe, expect, it, jest } from '@jest/globals';
import { Reflector } from '@nestjs/core';

import { InternalServiceAuthenticator } from '../../../../src/api/internal/internal-service.authenticator';
import {
  InternalServiceGuard,
  type InternalServiceRequest,
} from '../../../../src/api/internal/internal-service.guard';
import internalServiceConfig from '../../../../src/infrastructure/config/internal-service.config';
import { AppException } from '../../../../src/core/errors';

const digestOf = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const RUNTIME_TOKEN = 'runtime-token-value-0000000000000000';
const EXECUTOR_TOKEN = 'executor-token-value-000000000000000';

const configured = (
  credentials: readonly Record<string, unknown>[],
): ReturnType<typeof internalServiceConfig> =>
  ({ credentials }) as unknown as ReturnType<typeof internalServiceConfig>;

const authenticator = (
  credentials: readonly Record<string, unknown>[] = [
    {
      serviceId: 'ai-runtime',
      tokenSha256: digestOf(RUNTIME_TOKEN),
      capabilities: ['execution:step.lease', 'execution:step.settle'],
    },
    {
      serviceId: 'tool-executor',
      tokenSha256: digestOf(EXECUTOR_TOKEN),
      capabilities: ['execution:step.lease'],
    },
  ],
): InternalServiceAuthenticator =>
  new InternalServiceAuthenticator(configured(credentials));

function contextFor(headers: Record<string, string | undefined>) {
  const request = { headers } as unknown as InternalServiceRequest;

  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    },
  };
}

function guardFor(
  capability: string | undefined,
  auth = authenticator(),
): InternalServiceGuard {
  const reflector = {
    getAllAndOverride: jest.fn(() => capability),
  } as unknown as Reflector;

  return new InternalServiceGuard(reflector, auth);
}

describe('proving which service is calling', () => {
  it('parses the credential from the environment as digests, never as secrets', () => {
    process.env.INTERNAL_SERVICE_CREDENTIALS = JSON.stringify([
      {
        serviceId: 'ai-runtime',
        tokenSha256: digestOf(RUNTIME_TOKEN),
        capabilities: ['execution:step.lease'],
      },
    ]);

    const parsed = internalServiceConfig();

    expect(parsed.credentials).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain(RUNTIME_TOKEN);

    delete process.env.INTERNAL_SERVICE_CREDENTIALS;
  });

  it('accepts nobody when nothing is configured', () => {
    delete process.env.INTERNAL_SERVICE_CREDENTIALS;

    expect(internalServiceConfig().credentials).toEqual([]);
    expect(authenticator([]).configured).toBe(false);
    expect(
      authenticator([]).authenticate(`Bearer ${RUNTIME_TOKEN}`),
    ).toBeNull();
  });

  it.each([
    ['a malformed list', 'not-json'],
    [
      'a digest that is not one',
      '[{"serviceId":"a","tokenSha256":"nope","capabilities":["execution:step.lease"]}]',
    ],
    [
      'a capability nobody defined',
      `[{"serviceId":"a","tokenSha256":"${digestOf('x')}","capabilities":["execution:*"]}]`,
    ],
    [
      'no capability at all',
      `[{"serviceId":"a","tokenSha256":"${digestOf('x')}","capabilities":[]}]`,
    ],
    [
      'one credential for two services',
      `[{"serviceId":"a","tokenSha256":"${digestOf('x')}","capabilities":["execution:step.lease"]},` +
        `{"serviceId":"b","tokenSha256":"${digestOf('x')}","capabilities":["execution:step.lease"]}]`,
    ],
  ])('refuses to boot on %s', (_name, value) => {
    process.env.INTERNAL_SERVICE_CREDENTIALS = value;

    expect(() => internalServiceConfig()).toThrow();

    delete process.env.INTERNAL_SERVICE_CREDENTIALS;
  });

  it('identifies the service from the credential presented', () => {
    expect(authenticator().authenticate(`Bearer ${RUNTIME_TOKEN}`)).toEqual({
      serviceId: 'ai-runtime',
      capabilities: ['execution:step.lease', 'execution:step.settle'],
    });
    expect(authenticator().authenticate(`Bearer ${EXECUTOR_TOKEN}`)).toEqual({
      serviceId: 'tool-executor',
      capabilities: ['execution:step.lease'],
    });
  });

  it.each([
    ['an unknown credential', 'Bearer unknown-token-value-00000000000'],
    ['a digest replayed as the token', `Bearer ${digestOf(RUNTIME_TOKEN)}`],
    ['a credential with one character changed', `Bearer ${RUNTIME_TOKEN}x`],
    ['a scheme that is not Bearer', `Basic ${RUNTIME_TOKEN}`],
    ['no credential', undefined],
    ['an empty header', ''],
  ])('rejects %s', (_name, header) => {
    expect(authenticator().authenticate(header)).toBeNull();
  });

  it('cannot be forged by naming a service in a header', () => {
    const { context, request } = contextFor({
      'x-service-name': 'ai-runtime',
      'x-internal-service': 'ai-runtime',
    });

    expect(() =>
      guardFor('execution:step.lease').canActivate(context as never),
    ).toThrow(AppException);
    expect(request.internalService).toBeUndefined();
  });

  it('separates who is calling from what it may do', () => {
    const { context, request } = contextFor({
      authorization: `Bearer ${EXECUTOR_TOKEN}`,
    });

    // Authenticates, and is still refused the capability it does not hold.
    expect(
      authenticator().authenticate(`Bearer ${EXECUTOR_TOKEN}`),
    ).not.toBeNull();
    expect(() =>
      guardFor('execution:step.settle').canActivate(context as never),
    ).toThrow(new AppException('FORBIDDEN'));
    expect(request.internalService).toBeUndefined();
  });

  it('admits a service that holds the capability, and says which one it is', () => {
    const { context, request } = contextFor({
      authorization: `Bearer ${EXECUTOR_TOKEN}`,
    });

    expect(guardFor('execution:step.lease').canActivate(context as never)).toBe(
      true,
    );
    expect(request.internalService?.serviceId).toBe('tool-executor');
  });

  it('refuses a route that declared no capability rather than defaulting to open', () => {
    const { context } = contextFor({
      authorization: `Bearer ${RUNTIME_TOKEN}`,
    });

    expect(() => guardFor(undefined).canActivate(context as never)).toThrow(
      new AppException('FORBIDDEN'),
    );
  });
});
