import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  type CustomDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { AppException } from '../core/errors';
import { KnowledgeAuthorization } from './knowledge-authorization';

/**
 * Authorization for knowledge routes, as a guard rather than a method call.
 *
 * A guard because Nest runs guards *before* pipes. Checking inside the handler
 * means the body has already been parsed and validated, so a caller with no
 * access to the organization gets a validation error describing the request
 * shape — an answer they were not entitled to, and one that tells them the
 * route exists. It also cannot be forgotten: a new route without the decorator
 * has no permission at all, which fails loudly, where a new route missing an
 * `await this.authorize(...)` line would simply be open.
 *
 * Deliberately not Better Auth's `@MemberHasPermission`. That decorator
 * authorizes against the session's *active* organization, and every route here
 * names its organization in the path. For anyone belonging to two, the two are
 * different organizations, and the answer would be about the wrong one.
 */

const KNOWLEDGE_PERMISSION = 'knowledgePermission';

export type KnowledgePermission = 'read' | 'write';

export const RequiresKnowledge = (
  permission: KnowledgePermission,
): CustomDecorator<string> => SetMetadata(KNOWLEDGE_PERMISSION, permission);

@Injectable()
export class KnowledgePermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: KnowledgeAuthorization,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<
      KnowledgePermission | undefined
    >(KNOWLEDGE_PERMISSION, [context.getHandler(), context.getClass()]);

    /**
     * An unmarked route is refused, not allowed through. The default has to be
     * the safe one: a route added without the decorator is a mistake, and the
     * mistake should be a 403 in a test rather than an open surface.
     */
    if (permission === undefined) throw new AppException('FORBIDDEN');

    const request = context.switchToHttp().getRequest<
      Request & {
        params?: Record<string, string>;
        session?: { user?: { id?: unknown } };
      }
    >();

    const organizationId = request.params?.organizationId;
    const userId = request.session?.user?.id;

    if (typeof userId !== 'string' || userId.length === 0) {
      throw new AppException('UNAUTHORIZED');
    }

    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'organization' },
      });
    }

    await this.authorization.assertMay({
      organizationId,
      actorUserId: userId,
      permission,
    });

    return true;
  }
}
