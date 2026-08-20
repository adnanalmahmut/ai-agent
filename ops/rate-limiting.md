# Rate limiting

Normal Nest routes use a Redis exact sliding-window log. A single Lua script
prunes, counts, decides, conditionally inserts, computes reset time, and updates
TTL. Keys are versioned as `rl:v1`, use Express route templates, and select the
subject in this order: authenticated user, session, canonical `req.ip`.

Redis coordination failures fail open after the existing bounded command
timeout and emit a structured warning without request data. The response
contract uses `RateLimit-*` headers (or the validated configured prefix) plus
`Retry-After` and the standard localized `TOO_MANY_REQUESTS` envelope on 429.

Better Auth routes bypass Nest interception and therefore use Better Auth
1.6.27's database limiter. The `RateLimit` Prisma model was derived from the
installed package's `getAuthTables()` output, including the adapter-wide `id`
field added outside each model's field map. Sign-in and sign-up allow 5 per
60 seconds; password-reset allows 3. Both limiters rely only on the canonical
IP boundary established by host Nginx and `req.ip`; neither parses forwarded
header chains.
