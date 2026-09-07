// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { GET, POST } from './route';

/**
 * The proxy is the whole reason a real login works outside development, and
 * everything that could go wrong with it is a forwarding detail rather than a
 * decision. So this runs it against an actual HTTP server and checks what
 * arrived and what came back — not what it intended.
 */

type Recorded = {
  method: string;
  url: string;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
};

let received: Recorded[] = [];
let respond: (request: IncomingMessage) => {
  status: number;
  headers?: Record<string, string | string[]>;
  body?: string;
};

let upstream: Server;
let upstreamOrigin: string;

beforeAll(async () => {
  // The setup file forbids the network so nothing reaches it by accident.
  // This suite is the exception: forwarding cannot be tested without it.
  vi.unstubAllGlobals();

  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      const answer = respond(request);
      response.writeHead(answer.status, answer.headers ?? {});
      response.end(answer.body);
    });
  });

  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', () => resolve()),
  );
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.ADMIN_API_ORIGIN = upstreamOrigin;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

afterEach(() => {
  received = [];
  process.env.ADMIN_API_ORIGIN = upstreamOrigin;
});

const ok = () => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
});

const signIn = (init?: RequestInit) =>
  new Request('http://admin.test/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://admin.test',
      cookie: 'APP_LOCALE=ar',
      ...(init?.headers as Record<string, string> | undefined),
    },
    body: JSON.stringify({ email: 'staff@example.test', password: 'secret' }),
    ...init,
  });

describe('what reaches the Control Plane', () => {
  it('forwards the method, the path and the query unchanged', async () => {
    respond = ok;

    await GET(
      new Request('http://admin.test/api/auth/get-session?disableCookieCache=true'),
    );

    expect(received[0].method).toBe('GET');
    expect(received[0].url).toBe(
      '/api/auth/get-session?disableCookieCache=true',
    );
  });

  it('forwards the body byte for byte', async () => {
    respond = ok;
    const request = signIn();
    const sent = await request.clone().text();

    await POST(request);

    expect(received[0].body).toBe(sent);
  });

  it('forwards the cookie and the origin, which is what Better Auth checks', async () => {
    respond = ok;

    await POST(signIn());

    expect(received[0].headers.cookie).toBe('APP_LOCALE=ar');
    expect(received[0].headers.origin).toBe('http://admin.test');
    expect(received[0].headers['content-type']).toBe('application/json');
  });

  it('does not relay this surface as the upstream host', async () => {
    respond = ok;

    await POST(signIn());

    // The upstream has to address itself, or a reverse proxy in front of it
    // routes on the wrong name.
    expect(received[0].headers.host).not.toBe('admin.test');
  });

  it('adds no credential, header or claim of its own', async () => {
    respond = ok;

    await POST(signIn());

    const sent = Object.keys(received[0].headers);

    expect(sent).not.toContain('authorization');
    expect(sent).not.toContain('x-internal-service');
    // Only what the browser sent, plus what the HTTP client must set.
    expect(sent.filter((name) => name.startsWith('x-'))).toEqual([]);
  });

  it('reads the origin per request rather than once at startup', async () => {
    respond = ok;
    await GET(new Request('http://admin.test/api/auth/get-session'));

    process.env.ADMIN_API_ORIGIN = 'http://127.0.0.1:9';
    const answer = await GET(
      new Request('http://admin.test/api/auth/get-session'),
    );

    // Nothing baked in: the second request went somewhere else entirely.
    expect(answer.status).toBe(502);
    expect(received).toHaveLength(1);
  });

  it('refuses a path outside the auth prefix', async () => {
    respond = ok;

    const answer = await GET(
      new Request('http://admin.test/api/knowledge/documents'),
    );

    // An open proxy over the whole API would make this origin a way into
    // every Control Plane route from a browser.
    expect(answer.status).toBe(404);
    expect(received).toEqual([]);
  });
});

describe('what reaches the browser', () => {
  it('passes a refusal through as a refusal', async () => {
    respond = () => ({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: '{"code":"INVALID_EMAIL_OR_PASSWORD"}',
    });

    const answer = await POST(signIn());

    expect(answer.status).toBe(401);
    expect(await answer.text()).toBe('{"code":"INVALID_EMAIL_OR_PASSWORD"}');
  });

  it('keeps every Set-Cookie separate', async () => {
    respond = () => ({
      status: 200,
      headers: {
        'set-cookie': [
          '__Host-session=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
          'APP_LOCALE=ar; Path=/; SameSite=Lax',
        ],
      },
      body: '{"ok":true}',
    });

    const answer = await POST(signIn());

    // Folded into one header these are not cookies any more, and the reader
    // is signed in to nothing.
    expect(answer.headers.getSetCookie()).toEqual([
      '__Host-session=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
      'APP_LOCALE=ar; Path=/; SameSite=Lax',
    ]);
  });

  it('leaves cookie attributes exactly as the Control Plane set them', async () => {
    respond = () => ({
      status: 200,
      headers: {
        'set-cookie': [
          '__Host-session=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800',
        ],
      },
      body: '{}',
    });

    const answer = await POST(signIn());

    // Cookie policy belongs to whoever issues the cookie. Rewriting an
    // attribute here would be a security decision taken in a proxy.
    // `__Host-` is a browser-enforced contract on the cookie's own
    // attributes. Rewriting one here would break it silently.
    expect(answer.headers.getSetCookie()[0]).toBe(
      '__Host-session=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800',
    );
  });

  it('hands a redirect back instead of following it', async () => {
    respond = () => ({
      status: 302,
      headers: { location: 'http://control-plane.test/api/auth/callback/google' },
    });

    const answer = await GET(
      new Request('http://admin.test/api/auth/sign-in/social'),
    );

    expect(answer.status).toBe(302);
    expect(answer.headers.get('location')).toBe(
      'http://control-plane.test/api/auth/callback/google',
    );
  });

  it('sends no body where a status may not have one', async () => {
    respond = () => ({ status: 204 });

    const answer = await GET(new Request('http://admin.test/api/auth/sign-out'));

    expect(answer.status).toBe(204);
    expect(answer.body).toBeNull();
  });

  it('answers 502 when the Control Plane cannot be reached, and says no more', async () => {
    process.env.ADMIN_API_ORIGIN = 'http://127.0.0.1:9';

    const answer = await POST(signIn());

    expect(answer.status).toBe(502);
    expect(await answer.text()).toBe('');
  });
});
