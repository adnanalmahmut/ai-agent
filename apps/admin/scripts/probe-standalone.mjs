/**
 * What the built server actually does, asked of a running one.
 *
 * The unit suites can state how this application intends to be mounted; they
 * cannot establish where Next.js puts a base path at runtime, and that is the
 * one thing the deployment depends on. Two facts in particular are framework
 * behaviour rather than repository behaviour:
 *
 *   - a route handler is called with the base path already removed, so the
 *     auth forwarder hands the Control Plane its own path, and
 *   - the health route answers under the base path, which is what the
 *     container healthcheck has to probe.
 *
 * Both are asserted here against `next build`'s standalone output, with a stub
 * in place of the Control Plane so the probe needs no database, no session and
 * no credential. Run it after `pnpm --filter admin build`.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
const server = new URL('../.next/standalone/apps/admin/server.js', import.meta.url);

const BROWSER_HOST = 'staging.example.test';

let failures = 0;

function check(description, condition, detail) {
  if (condition) {
    process.stdout.write(`  ok  ${description}\n`);
    return;
  }

  failures += 1;
  process.stdout.write(`FAIL  ${description}\n`);
  if (detail !== undefined) {
    process.stdout.write(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  }
}

/** --- the Control Plane's stand-in ------------------------------------- */

let received = [];
let session = 'anonymous';

const SESSIONS = {
  anonymous: { status: 401, body: { message: 'unauthenticated' } },
  ordinary: {
    status: 200,
    body: { user: { id: 'usr_ordinary', email: 'reader@example.test', role: 'user' } },
  },
  staff: {
    status: 200,
    body: { user: { id: 'usr_staff', email: 'staff@example.test', role: 'super_admin' } },
  },
};

const upstream = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    received.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });

    if (request.url.startsWith('/api/auth/get-session')) {
      const answer = SESSIONS[session];
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
      return;
    }

    if (request.url.startsWith('/api/auth/')) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': [
          '__Host-session=probe-session; Path=/; HttpOnly; Secure; SameSite=Lax',
          'APP_LOCALE=en; Path=/; SameSite=Lax',
        ],
      });
      response.end(JSON.stringify({ receivedPath: request.url }));
      return;
    }

    // Nothing else is the auth path, and nothing else may be forwarded here.
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('the administrative surface must not reach this path');
  });
});

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  return port;
}

/** --- the application under test --------------------------------------- */

const upstreamPort = await freePort();
const applicationPort = await freePort();
upstream.listen(upstreamPort, '127.0.0.1');
await once(upstream, 'listening');

const child = spawn(process.execPath, [fileURLToPath(server)], {
  cwd: appDirectory,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: String(applicationPort),
    ADMIN_API_ORIGIN: `http://127.0.0.1:${upstreamPort}`,
    NEXT_PUBLIC_APP_NAME: 'Feedogo',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const output = [];
child.stdout.on('data', (chunk) => output.push(chunk.toString()));
child.stderr.on('data', (chunk) => output.push(chunk.toString()));

const base = `http://127.0.0.1:${applicationPort}`;

async function request(path, options = {}) {
  return fetch(`${base}${path}`, {
    redirect: 'manual',
    ...options,
    headers: { host: BROWSER_HOST, ...(options.headers ?? {}) },
  });
}

/**
 * The markup a reader sees, without the inlined scripts.
 *
 * The client provider ships the whole message catalog into the document, so
 * every page's HTML contains every string this application can render. A
 * check for one of them over the raw response would therefore pass on any
 * page at all -- including the one it is supposed to prove was not rendered.
 */
function visibleMarkup(html) {
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

async function waitForReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const answer = await request('/admin/health');
      if (answer.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`the standalone server never became ready:\n${output.join('')}`);
}

try {
  await waitForReady();

  /** --- mounting ------------------------------------------------------- */

  const root = await request('/');
  check('the root of the host is not this application', root.status === 404, root.status);

  received = [];
  const health = await request('/admin/health');
  check(
    'health answers under the base path',
    health.status === 200 && (await health.clone().json()).status === 'ok',
    health.status,
  );
  check('health needs no session and no API', received.length === 0, received);

  const rootHealth = await request('/health');
  check('health is not served off the base path', rootHealth.status === 404, rootHealth.status);

  const mount = await request('/admin');
  const mountLocation = new URL(mount.headers.get('location'), base);
  check(
    'the mount point redirects to the default locale beneath it',
    mount.status >= 300 && mount.status < 400 && mountLocation.pathname === '/admin/ar',
    `${mount.status} ${mount.headers.get('location')}`,
  );

  const forwarded = await request('/admin', {
    headers: { 'x-forwarded-host': BROWSER_HOST, 'x-forwarded-proto': 'https' },
  });
  check(
    'a redirect names the origin the reader is on',
    new URL(forwarded.headers.get('location')).origin === `https://${BROWSER_HOST}`,
    forwarded.headers.get('location'),
  );

  /** --- pages and assets ---------------------------------------------- */

  session = 'anonymous';
  const login = await request('/admin/en/login');
  const loginHtml = await login.text();
  const loginMarkup = visibleMarkup(loginHtml);
  check('the sign-in page renders', login.status === 200, login.status);
  check(
    'it is the sign-in page and not a redirect target',
    loginMarkup.includes('Administrative sign in') &&
      loginMarkup.includes('type="password"'),
    loginMarkup.slice(0, 200),
  );

  const arabic = await request('/admin/ar/login');
  const arabicHtml = await arabic.text();
  check(
    'the right-to-left locale renders as right-to-left',
    arabic.status === 200 && arabicHtml.includes('dir="rtl"'),
    arabic.status,
  );

  const asset = loginHtml.match(/\/admin\/_next\/static\/[^"']+/)?.[0];
  check('the page references its assets under the base path', asset !== undefined, asset);

  if (asset) {
    const served = await request(asset);
    check('static assets are served under the base path', served.status === 200, served.status);

    const offBase = await request(asset.replace('/admin', ''));
    check(
      'the same asset is not served off the base path, where the public site lives',
      offBase.status === 404,
      offBase.status,
    );
  }

  const signup = await request('/admin/en/signup');
  check('there is no account-creation page', signup.status === 404, signup.status);

  /** --- the auth forwarder -------------------------------------------- */

  received = [];
  const body = JSON.stringify({ email: 'staff@example.test', password: 'probe' });
  const signIn = await request('/admin/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `https://${BROWSER_HOST}`,
      cookie: 'APP_LOCALE=ar',
    },
    body,
  });

  check('the browser reaches auth under the base path', signIn.status === 200, signIn.status);
  check('exactly one request was forwarded', received.length === 1, received.length);

  const forwardedRequest = received[0] ?? { headers: {} };
  check(
    'the forwarded path is the Control Plane’s own, without the base path',
    forwardedRequest.url === '/api/auth/sign-in/email',
    forwardedRequest.url,
  );
  check('the method is preserved', forwardedRequest.method === 'POST', forwardedRequest.method);
  check('the body is preserved byte for byte', forwardedRequest.body === body, forwardedRequest.body);
  check(
    'the browser’s own origin is preserved, which is what CSRF checks read',
    forwardedRequest.headers.origin === `https://${BROWSER_HOST}`,
    forwardedRequest.headers.origin,
  );
  check('the cookie is preserved', forwardedRequest.headers.cookie === 'APP_LOCALE=ar', forwardedRequest.headers.cookie);
  check(
    'the upstream is addressed as itself, not as this surface',
    forwardedRequest.headers.host !== BROWSER_HOST,
    forwardedRequest.headers.host,
  );
  check(
    'no credential or staff claim is invented',
    forwardedRequest.headers.authorization === undefined &&
      forwardedRequest.headers['x-internal-service'] === undefined,
    Object.keys(forwardedRequest.headers),
  );
  check(
    'every Set-Cookie is relayed separately',
    signIn.headers.getSetCookie().length === 2 &&
      signIn.headers.getSetCookie()[0].startsWith('__Host-session='),
    signIn.headers.getSetCookie(),
  );
  check(
    'the session cookie is relayed exactly as the Control Plane set it',
    signIn.headers.getSetCookie()[0] ===
      '__Host-session=probe-session; Path=/; HttpOnly; Secure; SameSite=Lax',
    signIn.headers.getSetCookie()[0],
  );

  received = [];
  const rootAuth = await request('/api/auth/sign-in/email', { method: 'POST', body });
  check('auth is not served off the base path', rootAuth.status === 404, rootAuth.status);
  check('and nothing was forwarded from there', received.length === 0, received);

  received = [];
  const otherApi = await request('/admin/api/knowledge/documents');
  check('this is not a proxy for the rest of the API', otherApi.status === 404, otherApi.status);
  check('and nothing was forwarded from there either', received.length === 0, received);

  /** --- the gate ------------------------------------------------------- */

  session = 'anonymous';
  const anonymous = await request('/admin/en');
  const anonymousLocation = new URL(anonymous.headers.get('location') ?? '/', base);
  check(
    'an anonymous request to the workspace is sent to sign in, under the base path',
    anonymous.status >= 300 &&
      anonymous.status < 400 &&
      anonymousLocation.pathname === '/admin/en/login',
    `${anonymous.status} ${anonymous.headers.get('location')}`,
  );

  session = 'ordinary';
  const ordinary = await request('/admin/en');
  const ordinaryHtml = visibleMarkup(await ordinary.text());
  check('an ordinary account is refused', ordinary.status === 200, ordinary.status);
  check(
    'and is told nothing about what it would need',
    ordinaryHtml.includes('No access') &&
      !ordinaryHtml.includes('No administrative modules') &&
      !/super_admin|GLOBAL_ROLE|staff role/i.test(ordinaryHtml),
    ordinaryHtml.slice(0, 200),
  );

  session = 'staff';
  const staff = await request('/admin/en');
  const staffHtml = visibleMarkup(await staff.text());
  check(
    'a staff account reaches the shell',
    staff.status === 200 && staffHtml.includes('No administrative modules'),
    staff.status,
  );
  check('and is not shown the refusal', !staffHtml.includes('No access'), staffHtml.slice(0, 200));
} finally {
  child.kill('SIGTERM');
  upstream.close();
}

if (failures > 0) {
  process.stdout.write(`\n${failures} standalone probe assertion(s) failed\n`);
  process.stdout.write(output.join(''));
  process.exit(1);
}

process.stdout.write('\nadministrative surface under /admin: ok\n');
process.exit(0);
