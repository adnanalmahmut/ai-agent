import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppException } from '../../core/errors';
import type { KnowledgeAuthorization } from '../knowledge-authorization';
import {
  KnowledgePermissionGuard,
  type KnowledgePermission,
} from '../knowledge-permission.guard';

/**
 * The guard's own decisions, including the one no route can reach.
 *
 * Every knowledge route carries `@RequiresKnowledge`, so the unmarked-route
 * branch is unreachable end to end — and that is exactly why it is tested
 * here. It is the branch that decides what happens to a route someone adds
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

const reflectorReturning = (permission: KnowledgePermission | undefined) => {
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
    } as unknown as KnowledgeAuthorization,
  };
};

describe('KnowledgePermissionGuard', () => {
  it('refuses a route that declares no permission', async () => {
    const { authorization, calls } = authorizationSpy();
    const guard = new KnowledgePermissionGuard(
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
    const guard = new KnowledgePermissionGuard(
      reflectorReturning('read'),
      authorization,
    );

    await expect(
      guard.canActivate(contextFor({ organizationId: 'org_a' })),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('refuses when the path carries no organization', async () => {
    const { authorization } = authorizationSpy();
    const guard = new KnowledgePermissionGuard(
      reflectorReturning('read'),
      authorization,
    );

    await expect(
      guard.canActivate(contextFor({ userId: 'user_a' })),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('asks about the organization in the path, with the declared permission', async () => {
    const { authorization, calls } = authorizationSpy();
    const guard = new KnowledgePermissionGuard(
      reflectorReturning('write'),
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
      permission: 'write',
    });
  });
});
