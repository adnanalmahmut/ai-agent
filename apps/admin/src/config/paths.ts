/**
 * Where this surface is mounted, and where the Control Plane's auth lives.
 *
 * `ADMIN_BASE_PATH` is the path a browser reaches this application on. It is a
 * build-time constant because Next.js `basePath` is one: the router, every
 * asset URL and every route handler are resolved against it when the
 * application is compiled, so it cannot be a runtime input without the served
 * HTML and the JavaScript that hydrates it disagreeing about where they are.
 *
 * The deployment serves all four surfaces from one hostname today, so the
 * administrative one needs a path of its own. Moving it to a hostname of its
 * own later means removing this constant rather than changing it — a
 * deliberate migration, described in docs/security.md, and not something this
 * value can be made to straddle.
 *
 * The two auth paths below are different things and must not be conflated.
 * `AUTH_BASE_PATH` is the Control Plane's own path, which the forwarding route
 * hands a request on to unchanged. `BROWSER_AUTH_BASE_PATH` is where this
 * application answers, which is that same path underneath this application's
 * base path. Next.js removes the base path before a route handler sees a
 * request, so the forwarding route already works in the Control Plane's terms
 * — `apps/admin/scripts/probe-standalone.mjs` proves that against a running
 * server rather than assuming it.
 */
export const ADMIN_BASE_PATH = '/admin';

export const API_BASE_PATH = '/api';

export const AUTH_BASE_PATH = `${API_BASE_PATH}/auth`;

export const BROWSER_AUTH_BASE_PATH = `${ADMIN_BASE_PATH}${AUTH_BASE_PATH}`;
