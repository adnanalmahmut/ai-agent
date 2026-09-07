// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The server side of a real login, end to end within this process: the cookie
 * a browser holds, through the shared transport, to the Control Plane's
 * session endpoint, through the staff rule, to the outcome the gate acts on.
 *
 * Nothing is stubbed between those points — the transport, the origin
 * resolution and the predicate are the real ones, and the session endpoint is
 * an actual HTTP server answering in Better Auth's shape. What the real
 * deployment adds on top is that Better Auth accepts the admin origin and
 * issues that cookie in the first place, which
 * `apps/control-plane/test/e2e/platform/admin-origin.e2e-spec.ts` proves
 * against a real database.
 */

let sessionFor: (request: IncomingMessage) =>
  | { status: 401 }
  | { status: 200; user: Record<string, unknown> };
let received: { url: string; cookie?: string | string[] }[] = [];

let controlPlane: Server;
let cookie = '__Host-session=abc';

vi.mock('next/headers', () => ({
  headers: () =>
    Promise.resolve(new Headers(cookie ? { cookie } : undefined)),
}));

const { resolveAdminAccess } = await import('./admin-access');

beforeAll(async () => {
  vi.unstubAllGlobals();

  controlPlane = createServer((request, response) => {
    received.push({ url: request.url ?? '', cookie: request.headers.cookie });

    const answer = sessionFor(request);

    if (answer.status === 401) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED' } }));
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ success: true, data: { user: answer.user } }));
  });

  await new Promise<void>((resolve) =>
    controlPlane.listen(0, '127.0.0.1', () => resolve()),
  );
  process.env.ADMIN_API_ORIGIN = `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => controlPlane.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  cookie = '__Host-session=abc';
});

const signedInAs = (user: Record<string, unknown>) => {
  sessionFor = () => ({ status: 200, user });
};

describe('the session behind an administrative request', () => {
  it('asks the Control Plane, carrying the reader’s own cookie', async () => {
    signedInAs({ id: 'u1', email: 'staff@example.test', role: 'admin' });

    await resolveAdminAccess();

    expect(received).toEqual([
      {
        url: '/api/auth/get-session',
        cookie: '__Host-session=abc',
      },
    ]);
  });

  it('admits a real staff session', async () => {
    signedInAs({ id: 'u1', email: 'staff@example.test', role: 'admin' });

    expect(await resolveAdminAccess()).toEqual({
      kind: 'granted',
      session: { user: { id: 'u1', email: 'staff@example.test', role: 'admin' } },
    });
  });

  it('admits the highest platform role too', async () => {
    signedInAs({ id: 'u2', email: 'root@example.test', role: 'super_admin' });

    expect((await resolveAdminAccess()).kind).toBe('granted');
  });

  it('refuses an ordinary signed-in account', async () => {
    signedInAs({ id: 'u3', email: 'person@example.test', role: 'user' });

    // Signed in, and this is not their workspace.
    expect(await resolveAdminAccess()).toEqual({ kind: 'denied' });
  });

  it('refuses a suspended staff account', async () => {
    signedInAs({
      id: 'u4',
      email: 'ex@example.test',
      role: 'admin',
      banned: true,
    });

    expect(await resolveAdminAccess()).toEqual({ kind: 'denied' });
  });

  it('treats no cookie as nobody signed in', async () => {
    cookie = '';
    sessionFor = () => ({ status: 401 });

    expect(await resolveAdminAccess()).toEqual({ kind: 'anonymous' });
  });

  it('treats a rejected cookie as nobody signed in', async () => {
    sessionFor = () => ({ status: 401 });

    expect(await resolveAdminAccess()).toEqual({ kind: 'anonymous' });
  });

  it('denies rather than admits when the Control Plane cannot be reached', async () => {
    const reachable = process.env.ADMIN_API_ORIGIN;
    process.env.ADMIN_API_ORIGIN = 'http://127.0.0.1:9';

    try {
      expect(await resolveAdminAccess()).toEqual({ kind: 'unavailable' });
    } finally {
      process.env.ADMIN_API_ORIGIN = reachable;
    }
  });

  it('denies rather than admits when the origin is misconfigured', async () => {
    const reachable = process.env.ADMIN_API_ORIGIN;
    process.env.ADMIN_API_ORIGIN = 'not-a-url';

    try {
      expect(await resolveAdminAccess()).toEqual({ kind: 'unavailable' });
    } finally {
      process.env.ADMIN_API_ORIGIN = reachable;
    }
  });
});
