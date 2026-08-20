# Networking and canonical client IP

The public path is Internet → Lightsail static IP → host Nginx → loopback-bound
containers. Nginx overwrites `X-Real-IP` and `X-Forwarded-For` with
`$remote_addr`; it never appends an attacker-provided chain.

Nest/Express trusts zero proxy hops in development/test and exactly one in
staging/production. The application identity is `req.ip`; rate limiting never
parses forwarded headers. Better Auth reads only `x-real-ip`, which is safe
because direct local/test requests have those headers overwritten from the
socket before Better Auth handles them.

Tests prove that direct `X-Real-IP: 1.2.3.4` and `X-Forwarded-For: 1.2.3.4`
cannot change the stored session IP or application identity. Do not change
trust proxy to `true`, add broad proxy ranges, or place another proxy in front
without redesigning and retesting the boundary.

Canonical templates and assertions: [`ops/networking-real-ip.md`](../ops/networking-real-ip.md).
