import type {
  RateLimitConsumeParams,
  RateLimitDecision,
} from './rate-limit.types';

export abstract class RateLimiterPort {
  abstract consume(params: RateLimitConsumeParams): Promise<RateLimitDecision>;
}
