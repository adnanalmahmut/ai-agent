import 'server-only';

/**
 * Where the Control Plane is, read per call rather than captured once.
 *
 * The image is built once and run against whichever deployment points it at,
 * so this is a runtime input and never a baked constant: a container started
 * with a different `ADMIN_API_ORIGIN` talks to a different Control Plane
 * without being rebuilt.
 *
 * A malformed value throws, which fails the request closed — the gate reports
 * that access could not be established, and the auth proxy answers 502.
 */
export function apiOrigin(): string {
  const candidate = process.env.ADMIN_API_ORIGIN ?? 'http://127.0.0.1:3002';
  const url = new URL(candidate);

  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/') {
    throw new Error('ADMIN_API_ORIGIN must be an http(s) origin without a path');
  }

  return url.origin;
}
