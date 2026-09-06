import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { AuthService } from '@thallesp/nestjs-better-auth';
import request from 'supertest';

import authConfig from '../../../src/infrastructure/config/auth.config';
import {
  as,
  createHarness,
  createUser,
  type Harness,
} from '../../support/auth-harness';

const FAKE_SECRET = 'LEAKY_GOOGLE_SECRET';
const FAKE_CLIENT_ID = 'fake-client-id.apps.googleusercontent.com';

type AuthOptions = {
  account?: {
    encryptOAuthTokens?: boolean;
    accountLinking?: {
      enabled?: boolean;
      trustedProviders?: unknown;
      allowDifferentEmails?: boolean;
    };
  };
  session?: { cookieCache?: unknown };
};

describe('Google OAuth configuration', () => {
  const original = { ...process.env };

  afterAll(() => {
    process.env.GOOGLE_AUTH_ENABLED = original.GOOGLE_AUTH_ENABLED;
    process.env.GOOGLE_CLIENT_ID = original.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = original.GOOGLE_CLIENT_SECRET;
  });

  const withEnv = (env: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return authConfig();
  };

  it('boots with the feature off and no credentials present', () => {
    const config = withEnv({
      GOOGLE_AUTH_ENABLED: 'false',
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
    });

    expect(config.google).toBeNull();
  });

  it('treats an absent flag as off', () => {
    const config = withEnv({
      GOOGLE_AUTH_ENABLED: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
    });

    expect(config.google).toBeNull();
  });

  it('accepts credentials when the feature is on', () => {
    const config = withEnv({
      GOOGLE_AUTH_ENABLED: 'true',
      GOOGLE_CLIENT_ID: FAKE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: FAKE_SECRET,
    });

    expect(config.google).toEqual({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_SECRET,
    });
  });

  it('fails at boot when the client id is missing', () => {
    expect(() =>
      withEnv({
        GOOGLE_AUTH_ENABLED: 'true',
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: FAKE_SECRET,
      }),
    ).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it('fails at boot when the secret is present but empty', () => {
    expect(() =>
      withEnv({
        GOOGLE_AUTH_ENABLED: 'true',
        GOOGLE_CLIENT_ID: FAKE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: '',
      }),
    ).toThrow(/GOOGLE_CLIENT_SECRET/);
  });

  it('does not require Google variables to be well-formed while off', () => {
    expect(() =>
      withEnv({
        GOOGLE_AUTH_ENABLED: 'false',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
      }),
    ).not.toThrow();
  });
});

describe('Google OAuth disabled (e2e)', () => {
  let harness: Harness;

  beforeAll(async () => {
    process.env.GOOGLE_AUTH_ENABLED = 'false';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    harness = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('boots the whole application without Google credentials', async () => {
    await request(harness.server).get('/api/auth/ok').expect(200);
  });

  it('refuses a Google sign-in attempt', async () => {
    const response = await request(harness.server)
      .post('/api/auth/sign-in/social')
      .send({ provider: 'google', callbackURL: '/' });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('Google OAuth enabled (e2e)', () => {
  let harness: Harness;
  const captured: string[] = [];

  beforeAll(async () => {
    process.env.GOOGLE_AUTH_ENABLED = 'true';
    process.env.GOOGLE_CLIENT_ID = FAKE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = FAKE_SECRET;

    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      stream.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
        captured.push(String(chunk));
        return write(chunk, ...(rest as []));
      };
    }

    harness = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
    process.env.GOOGLE_AUTH_ENABLED = 'false';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  const initiate = () =>
    request(harness.server)
      .post('/api/auth/sign-in/social')
      .send({ provider: 'google', callbackURL: '/' });

  it('produces a Google authorization URL', async () => {
    const response = await initiate();

    expect(response.status).toBe(200);
    const url = new URL((response.body as { url: string }).url);
    expect(url.host).toBe('accounts.google.com');
  });

  it('sends the configured client id', async () => {
    const response = await initiate();
    const url = new URL((response.body as { url: string }).url);

    expect(url.searchParams.get('client_id')).toBe(FAKE_CLIENT_ID);
  });

  it('derives the redirect URI from the configured base URL', async () => {
    const response = await initiate();
    const url = new URL((response.body as { url: string }).url);

    const expected = new URL(
      '/api/auth/callback/google',
      process.env.BETTER_AUTH_URL,
    );
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${expected.origin}/api/auth/callback/google`,
    );
  });

  it('uses state and PKCE', async () => {
    const response = await initiate();
    const url = new URL((response.body as { url: string }).url);

    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('email');
  });

  it('never puts the client secret in the authorization URL', async () => {
    const response = await initiate();

    expect(JSON.stringify(response.body)).not.toContain(FAKE_SECRET);
  });

  it('rejects a callback whose state does not match', async () => {
    const response = await request(harness.server).get(
      '/api/auth/callback/google?code=fake-code&state=forged-state',
    );

    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('encrypts stored OAuth tokens', () => {
    const auth = harness.app.get(AuthService, { strict: false });
    const options = (auth.instance as unknown as { options: AuthOptions })
      .options;

    expect(options.account?.encryptOAuthTokens).toBe(true);
  });

  it('leaves account linking on the safe defaults', () => {
    const auth = harness.app.get(AuthService, { strict: false });
    const options = (auth.instance as unknown as { options: AuthOptions })
      .options;

    expect(options.account?.accountLinking?.trustedProviders).toBeUndefined();
    expect(
      options.account?.accountLinking?.allowDifferentEmails,
    ).toBeUndefined();
    expect(options.account?.accountLinking?.enabled).not.toBe(false);
  });

  it('configures no session cookie cache', () => {
    const auth = harness.app.get(AuthService, { strict: false });
    const options = (auth.instance as unknown as { options: AuthOptions })
      .options;

    expect(options.session?.cookieCache).toBeUndefined();
  });

  it('cannot create a session for a deactivated account', async () => {
    const superAdmin = await createUser(harness, { role: 'super_admin' });
    const victim = await createUser(harness);

    await as(harness, superAdmin)
      .post(`/admin/users/${victim.id}/deactivate`)
      .expect(201);

    await expect(
      harness.prisma.session.count({ where: { userId: victim.id } }),
    ).resolves.toBe(0);

    const signIn = await request(harness.server)
      .post('/api/auth/sign-in/email')
      .send({ email: victim.email, password: victim.password });

    expect(signIn.status).toBe(403);
    await expect(
      harness.prisma.session.count({ where: { userId: victim.id } }),
    ).resolves.toBe(0);
  });

  it('never writes the client secret to stdout or stderr', () => {
    expect(captured.join('')).not.toContain(FAKE_SECRET);
  });
});
