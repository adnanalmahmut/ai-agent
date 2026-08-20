import { SetMetadata } from '@nestjs/common';
import type { RateLimitPolicy } from './rate-limit.types';

export const RATE_LIMIT_POLICY = Symbol('RATE_LIMIT_POLICY');
export const RATE_LIMIT_SKIP = Symbol('RATE_LIMIT_SKIP');
export const USER_RATE_LIMIT_POLICY = Symbol('USER_RATE_LIMIT_POLICY');
export const SESSION_RATE_LIMIT_POLICY = Symbol('SESSION_RATE_LIMIT_POLICY');

export const RateLimit = (policy: RateLimitPolicy) =>
  SetMetadata(RATE_LIMIT_POLICY, policy);
export const RateLimitSkip = () => SetMetadata(RATE_LIMIT_SKIP, true);
export const UserRateLimit = (policy: RateLimitPolicy) =>
  SetMetadata(USER_RATE_LIMIT_POLICY, policy);
export const SessionRateLimit = (policy: RateLimitPolicy) =>
  SetMetadata(SESSION_RATE_LIMIT_POLICY, policy);
