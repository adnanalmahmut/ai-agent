import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppException } from '../../../../src/core/errors';
import type { OrganizationAccess } from '../../../../src/infrastructure/auth/organization-access.service';
import { OrganizationPermissionGuard } from '../../../../src/infrastructure/auth/organization-permission.guard';
import type { OrganizationPermissionRequest } from '../../../../src/infrastructure/auth/permissions';

const contextFor = (input: {
  organizationId?: string;
  userId?: unknown;
}): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({
        params:
          input.organizationId === undefined
            ? {}
            : { organizationId: input.organizationId },
        session:
          input.userId === undefined
            ? undefined
            : { user: { id: input.userId } },
      }),
    }),
  }) as unknown as ExecutionContext;

const reflectorReturning = (
  permission: OrganizationPermissionRequest | undefined,
) => {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(permission);

  return reflector;
};

const authorizationSpy = () => {
  const calls: unknown[] = [];

  return {
    calls,
    authorization: {
      assertMay: (input: unknown) => {
        calls.push(input);

        return Promise.resolve();
      },
    } as unknown as OrganizationAccess,
  };
};

describe('OrganizationPermissionGuard', () => {
  it('refuses a route that declares no permission', async () => {
    const { authorization, calls } = authorizationSpy();
    const guard = new OrganizationPermissionGuard(
      reflectorReturning(undefined),
      authorization,
    );

    await expect(
      guard.canActivate(
        contextFor({ organizationId: 'org_a', userId: 'user_a' }),
      ),
    ).rejects.toBeInstanceOf(AppException);

    expect(calls).toHaveLength(0);
  });

  it('refuses when no session reached the request', async () => {
    const { authorization } = authorizationSpy();
    const guard = new OrganizationPermissionGuard(
      reflectorReturning({ knowledge: ['read'] }),
      authorization,
    );

    await expect(
      guard.canActivate(contextFor({ organizationId: 'org_a' })),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('refuses when the path carries no organization', async () => {
    const { authorization } = authorizationSpy();
    const guard = new OrganizationPermissionGuard(
      reflectorReturning({ knowledge: ['read'] }),
      authorization,
    );

    await expect(
      guard.canActivate(contextFor({ userId: 'user_a' })),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('asks about the organization in the path, with the declared permission', async () => {
    const { authorization, calls } = authorizationSpy();
    const guard = new OrganizationPermissionGuard(
      reflectorReturning({ knowledge: ['write'] }),
      authorization,
    );

    await expect(
      guard.canActivate(
        contextFor({ organizationId: 'org_a', userId: 'user_a' }),
      ),
    ).resolves.toBe(true);

    expect(calls[0]).toEqual({
      organizationId: 'org_a',
      actorUserId: 'user_a',
      permission: { knowledge: ['write'] },
    });
  });
});
