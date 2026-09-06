export type RateLimitPolicy = { points: number; durationSec: number };

export type RateLimitConsumeParams = RateLimitPolicy & {
  key: string;
  requestId: string;
  nowMs?: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
};

export type RateLimitRequest = {
  method: string;
  ip?: string;
  baseUrl?: string;
  path?: string;
  route?: { path?: string | string[] };
  id?: string;
  user?: { id?: string };
  session?: { id?: string; session?: { id?: string } };
};
