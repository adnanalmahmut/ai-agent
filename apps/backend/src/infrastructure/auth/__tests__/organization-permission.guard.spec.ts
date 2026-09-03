import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppException } from '../../../core/errors';
import type { OrganizationAccess } from '../organization-access.service';
import { OrganizationPermissionGuard } from '../organization-permission.guard';
import type { OrganizationPermissionRequest } from '../permissions';

/**
 * The guard's own decisions, including the one no route can reach.
 *
 * Every guarded route carries `@RequiresOrganizationPermission`, so the
 * unmarked-route branch is unreachable end to end — and that is exactly why it
 * is tested here. It is the branch that decides what happens to a route someone adds
 * next year and forgets to mark, and if it ever became `return true` no
 * existing test would notice while the new route stood open.
 */

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

    // And it did not fall through to an authorization question either.
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
