import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import type { Observable } from 'rxjs';
import { httpConfig } from '../config';
import { AppException } from '../../core/errors';
import {
  RATE_LIMIT_POLICY,
  RATE_LIMIT_SKIP,
  SESSION_RATE_LIMIT_POLICY,
  USER_RATE_LIMIT_POLICY,
} from './rate-limit.decorators';
import { RateLimiterPort } from './rate-limiter.port';
import type {
  RateLimitDecision,
  RateLimitPolicy,
  RateLimitRequest,
} from './rate-limit.types';

type HeaderResponse = { setHeader(name: string, value: string | number): void };
type BudgetKind = 'normal' | 'user' | 'session';

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiterPort,
    @Inject(httpConfig.KEY)
    private readonly config: ConfigType<typeof httpConfig>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RateLimitInterceptor.name);
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (
      !this.config.rateLimit.enabled ||
      this.metadata<boolean>(context, RATE_LIMIT_SKIP)
    )
      return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<RateLimitRequest>();
    const response = http.getResponse<HeaderResponse>();
    const route = normalizedRouteTemplate(request);
    const requestId = request.id ?? randomUUID();
    const normal = this.metadata<RateLimitPolicy>(
      context,
      RATE_LIMIT_POLICY,
    ) ?? {
      points: this.config.rateLimit.points,
      durationSec: this.config.rateLimit.durationSec,
    };
    await this.applyBudget(
      'normal',
      response,
      normal,
      route,
      normalSubject(request),
      requestId,
    );

    const user = this.metadata<RateLimitPolicy>(
      context,
      USER_RATE_LIMIT_POLICY,
    );
    if (user) {
      if (!request.user?.id) throw new AppException('UNAUTHORIZED');
      await this.applyBudget(
        'user',
        response,
        user,
        route,
        `user:${request.user.id}`,
        requestId,
      );
    }
    const session = this.metadata<RateLimitPolicy>(
      context,
      SESSION_RATE_LIMIT_POLICY,
    );
    if (session) {
      const id = sessionId(request);
      if (!id) throw new AppException('UNAUTHORIZED');
      await this.applyBudget(
        'session',
        response,
        session,
        route,
        `session:${id}`,
        requestId,
      );
    }
    return next.handle();
  }

  private metadata<T>(context: ExecutionContext, key: symbol): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [
      context.getHandler(),
      context.getClass(),
    ]);
  }

  private async applyBudget(
    kind: BudgetKind,
    response: HeaderResponse,
    policy: RateLimitPolicy,
    route: string,
    subject: string,
    requestId: string,
  ): Promise<void> {
    let decision: RateLimitDecision;
    try {
      decision = await this.limiter.consume({
        key: `${kind}:${route}:${subject}`,
        requestId: `${requestId}:${kind}`,
        ...policy,
      });
    } catch (error) {
      this.logger.warn(
        {
          errorType: error instanceof Error ? error.name : 'UnknownError',
          kind,
        },
        'Redis rate limiting failed open',
      );
      return;
    }
    this.writeHeaders(response, kind, decision);
    if (!decision.allowed) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((decision.resetAtMs - Date.now()) / 1_000),
      );
      response.setHeader('Retry-After', retryAfterSec);
      throw new AppException('TOO_MANY_REQUESTS', {
        publicDetails: { retryAfterSec },
      });
    }
  }

  private writeHeaders(
    response: HeaderResponse,
    kind: BudgetKind,
    decision: RateLimitDecision,
  ): void {
    const prefix = this.config.rateLimit.headerPrefix;
    const qualifier =
      kind === 'normal' ? '' : `-${kind[0].toUpperCase()}${kind.slice(1)}`;
    response.setHeader(`${prefix}${qualifier}-Limit`, decision.limit);
    response.setHeader(`${prefix}${qualifier}-Remaining`, decision.remaining);
    response.setHeader(
      `${prefix}${qualifier}-Reset`,
      Math.ceil(decision.resetAtMs / 1_000),
    );
  }
}

export function normalizedRouteTemplate(request: RateLimitRequest): string {
  const routePath = Array.isArray(request.route?.path)
    ? request.route.path[0]
    : request.route?.path;
  const template = `${request.baseUrl ?? ''}${routePath ?? request.path ?? '/'}`;
  const normalized = template.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  return `${request.method.toUpperCase()}:${normalized}`;
}

export function normalSubject(request: RateLimitRequest): string {
  if (request.user?.id) return `user:${request.user.id}`;
  const id = sessionId(request);
  if (id) return `session:${id}`;
  return `ip:${request.ip ?? 'unknown'}`;
}

function sessionId(request: RateLimitRequest): string | undefined {
  return request.session?.id ?? request.session?.session?.id;
}
