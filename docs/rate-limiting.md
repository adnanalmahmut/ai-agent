# Rate limiting

Normal Nest routes are limited automatically by an exact Redis sliding-window
log. One Lua script prunes, counts, decides, conditionally inserts, computes
remaining/reset, and updates TTL atomically. Rejected requests add nothing and
do not extend their own ban.

Keys are `rl:v1:<budget>:<METHOD:route-template>:<subject>`. Subject priority is
user, session, then canonical `req.ip`. `@RateLimit`, `@RateLimitSkip`,
`@UserRateLimit`, and `@SessionRateLimit` add explicit policy. Responses expose
`RateLimit-{Limit,Remaining,Reset}` and optional User/Session variants; rejection
uses `Retry-After` plus the localized standard 429 envelope.

Redis failure is explicitly fail-open for ordinary routes, bounded by the
request-facing Redis connection, and logged without request data. Better Auth
independently stores concurrency-safe counters in PostgreSQL: sign-in/sign-up
5 per 60 seconds and password reset 3 per 60 seconds.

Algorithm details and tests: [`ops/rate-limiting.md`](../ops/rate-limiting.md).
