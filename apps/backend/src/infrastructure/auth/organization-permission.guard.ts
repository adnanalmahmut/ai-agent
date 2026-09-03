import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  type CustomDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { AppException } from '../../core/errors';
import { OrganizationAccess } from './organization-access.service';
import type { OrganizationPermissionRequest } from './permissions';

const ORGANIZATION_PERMISSION = 'organizationPermission';

export const RequiresOrganizationPermission = (
  permission: OrganizationPermissionRequest,
): CustomDecorator<string> => SetMetadata(ORGANIZATION_PERMISSION, permission);

@Injectable()
export class OrganizationPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: OrganizationAccess,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<
      OrganizationPermissionRequest | undefined
    >(ORGANIZATION_PERMISSION, [context.getHandler(), context.getClass()]);

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
