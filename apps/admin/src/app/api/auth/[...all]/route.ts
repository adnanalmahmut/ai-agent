import { ADMIN_BASE_PATH, AUTH_BASE_PATH } from '@/config/paths';
import { apiOrigin } from '@/config/server';

/**
 * The browser's path to Better Auth.
 *
 * The admin surface has no auth of its own, so signing in has to reach the
 * Control Plane. Doing that from the browser directly would be a cross-origin
 * request: the session cookie would have to be third-party to this surface,
 * which is a cookie and origin design, and that belongs to the secure-origin
 * work rather than here. So the request is made same-origin and forwarded from
 * this process, where the cookie the Control Plane sets lands on the origin
 * the reader is actually on.
 *
 * There is no authentication logic here and there must never be any. This
 * hands the request over unchanged and hands the answer back unchanged: the
 * method, the path, the query, the body, the headers the browser sent, and on
 * the way back the status, the headers and every `Set-Cookie` separately.
 * Better Auth still runs its own origin and CSRF checks against the origin the
 * browser reported, which is why that origin has to be a trusted one.
 *
 * Only the auth path: `/admin/api/auth/*` from the browser, `/api/auth/*`
 * upstream, and nothing else in either direction. An open proxy over the whole
 * API would turn this surface into an unauthenticated way into every Control
 * Plane route from a browser, which is the opposite of what a narrow
 * administrative surface is for.
 */
export const dynamic = 'force-dynamic';

/**
 * Hop-by-hop headers describe one connection and may not be relayed onto the
 * next. `content-length` and `accept-encoding` come off too: the body is
 * re-framed here and `fetch` negotiates its own encoding.
 */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const REQUEST_HEADERS_WITHHELD = new Set([
  ...HOP_BY_HOP,
  // The upstream must address itself, not this surface.
  'host',
  'content-length',
  'accept-encoding',
]);

const RESPONSE_HEADERS_WITHHELD = new Set([
  ...HOP_BY_HOP,
  // `fetch` has already decoded and re-framed the body, so the upstream's
  // framing headers would describe bytes that no longer exist.
  'content-length',
  'content-encoding',
  // Relayed separately: `Headers` folds repeated values into one string, and
  // a folded `Set-Cookie` is not a cookie any more.
  'set-cookie',
]);

/** Statuses whose responses may not carry a body at all. */
const BODILESS = new Set([101, 204, 205, 304]);

/**
 * The Control Plane's own path for an incoming request, or `null` if this
 * route is not allowed to forward it.
 *
 * The browser asks for `/admin/api/auth/...` and the Control Plane serves
 * `/api/auth/...`. Next.js removes the base path before a route handler is
 * called, so what arrives here is already the upstream's path — but that is a
 * framework behaviour rather than a promise, and the failure if it changed
 * would be a 404 from the far end that looks nothing like its cause. So the
 * prefix is removed if it is there, and the result is required to be under the
 * auth path either way.
 *
 * `apps/admin/scripts/probe-standalone.mjs` asserts what a real standalone
 * server actually forwards, so the branch that is dead today is dead because
 * something checked.
 */
function upstreamPath(pathname: string): string | null {
  const path =
    pathname === ADMIN_BASE_PATH
      ? '/'
      : pathname.startsWith(`${ADMIN_BASE_PATH}/`)
        ? pathname.slice(ADMIN_BASE_PATH.length)
        : pathname;

  if (path !== AUTH_BASE_PATH && !path.startsWith(`${AUTH_BASE_PATH}/`)) {
    return null;
  }

  return path;
}

async function forward(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const forwardedPath = upstreamPath(incoming.pathname);

  if (forwardedPath === null) {
    return new Response(null, { status: 404 });
  }

  const requestHeaders = new Headers();
  request.headers.forEach((value, name) => {
    if (!REQUEST_HEADERS_WITHHELD.has(name)) requestHeaders.set(name, value);
  });

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;

  try {
    upstream = await fetch(
      new URL(`${forwardedPath}${incoming.search}`, apiOrigin()),
      {
        method: request.method,
        headers: requestHeaders,
        body: hasBody ? await request.arrayBuffer() : undefined,
        // A redirect is an answer for the browser to act on, not something to
        // follow here: following one would resolve it against this process's
        // view of the network rather than the reader's.
        redirect: 'manual',
        cache: 'no-store',
      },
    );
  } catch {
    // Unreachable, misconfigured, or refused. Which of those it was is not
    // something a browser needs told.
    return new Response(null, { status: 502 });
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!RESPONSE_HEADERS_WITHHELD.has(name)) responseHeaders.append(name, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', cookie);
  }

  return new Response(BODILESS.has(upstream.status) ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = forward;
export const POST = forward;
