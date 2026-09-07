import { createServer } from 'node:http';

const port = Number(process.env.PLATFORM_E2E_API_PORT ?? 4174);
const organizationId = 'org_smoke';
const userId = 'user_smoke';

const session = {
  session: {
    id: 'session_smoke',
    userId,
    expiresAt: '2099-01-01T00:00:00.000Z',
    token: 'smoke',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    activeOrganizationId: organizationId,
  },
  user: {
    id: userId,
    name: 'Smoke Operator',
    email: 'smoke@example.test',
    emailVerified: true,
    image: null,
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

const organization = {
  id: organizationId,
  name: 'Smoke Works',
  slug: 'smoke-works',
  logo: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  metadata: null,
  members: [
    {
      id: 'member_smoke',
      organizationId,
      userId,
      role: 'owner',
      createdAt: '2026-01-01T00:00:00.000Z',
      user: {
        id: userId,
        name: 'Smoke Operator',
        email: 'smoke@example.test',
        image: null,
      },
    },
  ],
  invitations: [],
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const sessionMode = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('platform-e2e-session='))
    ?.split('=')[1];
  let body;

  if (url.pathname === '/health') body = { ok: true };
  if (url.pathname === '/api/auth/get-session') {
    if (sessionMode === 'outage') {
      request.socket.destroy();
      return;
    }
    if (sessionMode === 'anonymous') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }));
      return;
    }
    body = session;
  }
  if (url.pathname === '/api/auth/organization/list') body = [organization];
  if (url.pathname === '/api/organizations/archived') {
    body = { success: true, data: [] };
  }
  if (url.pathname === '/api/auth/organization/get-full-organization') {
    body = organization;
  }

  if (body === undefined) {
    response.writeHead(404).end();
    return;
  }

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
});

server.listen(port, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
