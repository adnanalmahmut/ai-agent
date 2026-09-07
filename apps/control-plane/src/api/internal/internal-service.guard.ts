import {
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { AppException } from '../../core/errors';
import type { InternalServiceCapability } from '../../infrastructure/config';
import {
  InternalServiceAuthenticator,
  type InternalServicePrincipal,
} from './internal-service.authenticator';

const INTERNAL_SERVICE_CAPABILITY = 'internalServiceCapability';

export const RequiresServiceCapability = (
  capability: InternalServiceCapability,
): CustomDecorator<string> =>
  SetMetadata(INTERNAL_SERVICE_CAPABILITY, capability);

export type InternalServiceRequest = Request & {
  internalService?: InternalServicePrincipal;
};

/**
 * Authentication and authorization, in that order and as two separate
 * questions.
 *
 * Proving which service is calling says nothing about what it may do, so a
 * route without a declared capability is refused rather than defaulted: a
 * handler added without one is inaccessible instead of open.
 */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: InternalServiceAuthenticator,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const capability = this.reflector.getAllAndOverride<
      InternalServiceCapability | undefined
    >(INTERNAL_SERVICE_CAPABILITY, [context.getHandler(), context.getClass()]);

    if (capability === undefined) throw new AppException('FORBIDDEN');

    const request = context.switchToHttp().getRequest<InternalServiceRequest>();

    const principal = this.authenticator.authenticate(
      request.headers.authorization,
    );

    if (!principal) throw new AppException('UNAUTHORIZED');
    if (!principal.capabilities.includes(capability)) {
      throw new AppException('FORBIDDEN');
    }

    request.internalService = principal;

    return true;
  }
}
