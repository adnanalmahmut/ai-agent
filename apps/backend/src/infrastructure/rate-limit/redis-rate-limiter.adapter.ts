import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis';
import { RateLimiterPort } from './rate-limiter.port';
import type {
  RateLimitConsumeParams,
  RateLimitDecision,
} from './rate-limit.types';

export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetAt = now + window
  if oldest[2] then resetAt = tonumber(oldest[2]) + window end
  return {0, 0, resetAt}
end
redis.call('ZADD', key, now, member)
count = count + 1
redis.call('PEXPIRE', key, window)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetAt = now + window
if oldest[2] then resetAt = tonumber(oldest[2]) + window end
return {1, limit - count, resetAt}
`;

@Injectable()
export class RedisRateLimiterAdapter extends RateLimiterPort {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async consume(params: RateLimitConsumeParams): Promise<RateLimitDecision> {
    const nowMs = params.nowMs ?? Date.now();
    const result = (await this.redis.connection.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      `rl:v1:${params.key}`,
      nowMs,
      params.durationSec * 1_000,
      params.points,
      `${nowMs}:${params.requestId}`,
    )) as [number, number, number];
    return {
      allowed: result[0] === 1,
      limit: params.points,
      remaining: Number(result[1]),
      resetAtMs: Number(result[2]),
    };
  }
}
