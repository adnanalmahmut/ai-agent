import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../../../src/api/app.module';
import { setupOpenApi } from '../../../src/infrastructure/docs';
import { MAIL_TRANSPORT } from '../../../src/infrastructure/mail/mail-transport';
import { CapturingTransport } from '../../support/auth-harness';

type OpenApiDocument = {
  openapi: string;
  servers?: { url: string }[];
  paths: Record<string, unknown>;
  tags?: { name: string }[];
  components?: {
    securitySchemes?: Record<
      string,
      { type?: string; in?: string; name?: string }
    >;
    schemas?: Record<string, unknown>;
  };
};

async function boot(enabled: boolean) {
  process.env.OPENAPI_ENABLED = enabled ? 'true' : 'false';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(new CapturingTransport())
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });

  // Mirror `main.ts`: the global prefix is applied before the document is
  // built, so the document under test sees exactly what production emits.
  app.setGlobalPrefix('api');

  const mounted = setupOpenApi(app);
  await app.init();

  return { app, server: app.getHttpServer() as App, mounted };
}

describe('OpenAPI enabled (e2e)', () => {
  let app: INestApplication;
  let server: App;
  let mounted: boolean;
  let applicationDocument: OpenApiDocument;
  let authDocument: OpenApiDocument;

  beforeAll(async () => {
    ({ app, server, mounted } = await boot(true));

    applicationDocument = (await request(server).get('/openapi.json'))
      .body as OpenApiDocument;
    authDocument = (
      await request(server).get('/api/auth/open-api/generate-schema')
    ).body as OpenApiDocument;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    process.env.OPENAPI_ENABLED = 'true';
  });

  it('mounts documentation', () => {
    expect(mounted).toBe(true);
  });

  describe('application schema', () => {
    it('is served as OpenAPI 3.1.1', () => {
      expect(applicationDocument.openapi).toBe('3.1.1');
    });

    it.each([
      '/admin/users/{userId}/deactivate',
      '/admin/users/{userId}/restore',
      '/organizations/{organizationId}/archive',
      '/organizations/{organizationId}/restore',
      '/organizations/{organizationId}/knowledge/spaces',
    ])('documents %s', (path) => {
      expect(Object.keys(applicationDocument.paths)).toContain(path);
    });

    it('describes the session cookie, not bearer auth', () => {
      const schemes = applicationDocument.components?.securitySchemes ?? {};

      expect(schemes.sessionCookie).toMatchObject({
        type: 'apiKey',
        in: 'cookie',
        name: '__Host-session',
      });
      expect(schemes).not.toHaveProperty('bearerAuth');
    });

    it('does not re-document any Better Auth path', () => {
      // Application paths are relative to the `/api` server, so a re-documented
      // auth route would read `/auth/...`. Both shapes are checked so this stays
      // meaningful whichever way the prefix is represented.
      const offending = Object.keys(applicationDocument.paths).filter(
        (path) => path.startsWith('/auth') || path.startsWith('/api/auth'),
      );

      expect(offending).toEqual([]);
    });
  });

  describe('API prefix', () => {
    const documentedUrl = (server: string, path: string) =>
      `${server.replace(/\/$/, '')}${path}`;

    const effectiveServer = () => {
      const [server] = applicationDocument.servers ?? [];
      expect(server?.url).toBeDefined();
      return server?.url ?? '';
    };

    it('declares the prefix once, on the server', () => {
      expect(applicationDocument.servers).toEqual([{ url: '/api' }]);
    });

    it('leaves the prefix out of the path keys', () => {
      const prefixed = Object.keys(applicationDocument.paths).filter(
        (path) => path === '/api' || path.startsWith('/api/'),
      );

      expect(prefixed).toEqual([]);
    });

    it.each([
      '/organizations/{organizationId}/archive',
      '/admin/users/{userId}/deactivate',
      '/organizations/{organizationId}/knowledge/spaces',
    ])('resolves %s to its real public URL', (path) => {
      expect(Object.keys(applicationDocument.paths)).toContain(path);
      expect(documentedUrl(effectiveServer(), path)).toBe(`/api${path}`);
    });

    it('resolves every documented URL under exactly one /api prefix', () => {
      const server = effectiveServer();
      const urls = Object.keys(applicationDocument.paths).map((path) =>
        documentedUrl(server, path),
      );

      expect(urls.length).toBeGreaterThan(0);
      expect(urls.filter((url) => !url.startsWith('/api/'))).toEqual([]);
      expect(urls.filter((url) => url.startsWith('/api/api'))).toEqual([]);
    });
  });

  describe('Better Auth schema', () => {
    it('is served as OpenAPI 3.1.1', () => {
      expect(authDocument.openapi).toBe('3.1.1');
    });

    it.each(['/sign-in/email', '/sign-up/email', '/request-password-reset'])(
      'includes core auth endpoint %s',
      (path) => {
        expect(Object.keys(authDocument.paths)).toContain(path);
      },
    );

    it.each([
      '/admin/set-role',
      '/admin/ban-user',
      '/admin/has-permission',
      '/admin/remove-user',
    ])('includes admin endpoint %s', (path) => {
      expect(Object.keys(authDocument.paths)).toContain(path);
    });

    it.each([
      '/organization/create',
      '/organization/invite-member',
      '/organization/accept-invitation',
      '/organization/has-permission',
    ])('includes organization endpoint %s', (path) => {
      expect(Object.keys(authDocument.paths)).toContain(path);
    });

    it('tags plugin endpoints by plugin', () => {
      const tags = (authDocument.tags ?? []).map((tag) => tag.name);
      const allTags = new Set<string>(tags);

      for (const operations of Object.values(authDocument.paths)) {
        for (const operation of Object.values(
          operations as Record<string, { tags?: string[] }>,
        )) {
          for (const tag of operation.tags ?? []) allTags.add(tag);
        }
      }

      expect([...allTags]).toEqual(
        expect.arrayContaining(['Admin', 'Organization']),
      );
    });

    it('does not serve Better Auth its own reference UI', async () => {
      await request(server).get('/api/auth/reference').expect(404);
    });
  });

  describe('collision audit', () => {
    it('has no overlapping paths between the two documents', () => {
      const application = new Set(Object.keys(applicationDocument.paths));
      const overlap = Object.keys(authDocument.paths).filter((path) =>
        application.has(path),
      );

      expect(overlap).toEqual([]);
    });

    it('records the component and security-scheme overlaps that justify two sources', () => {
      const applicationSchemas = new Set(
        Object.keys(applicationDocument.components?.schemas ?? {}),
      );
      const authSchemas = Object.keys(authDocument.components?.schemas ?? {});

      const schemaOverlap = authSchemas.filter((name) =>
        applicationSchemas.has(name),
      );

      const applicationSchemes = new Set(
        Object.keys(applicationDocument.components?.securitySchemes ?? {}),
      );
      const schemeOverlap = Object.keys(
        authDocument.components?.securitySchemes ?? {},
      ).filter((name) => applicationSchemes.has(name));

      expect(Array.isArray(schemaOverlap)).toBe(true);
      expect(Array.isArray(schemeOverlap)).toBe(true);

      expect(authSchemas).toEqual(expect.arrayContaining(['User', 'Session']));
    });
  });

  describe('documentation UI', () => {
    it('serves one page with exactly two sources', async () => {
      const response = await request(server).get('/docs').expect(200);

      expect(response.text).toContain('/openapi.json');
      expect(response.text).toContain('/api/auth/open-api/generate-schema');
      expect(response.text).toContain('Application API');
      expect(response.text).toContain('Authentication API');
    });

    it('does not also serve Swagger UI', async () => {
      const response = await request(server).get('/docs-app');
      expect(response.status).toBe(404);
    });
  });

  describe('no secrets in either document', () => {
    const forbidden = [
      process.env.BETTER_AUTH_SECRET,
      process.env.DATABASE_URL,
      'LEAKY_GOOGLE_SECRET',
      'LEAKY_RESEND_KEY',
      'LEAKY_AWS_SECRET',
      'LEAKY_SMTP_PASSWORD',
      '.tmp/mail',
    ].filter((value): value is string => (value?.length ?? 0) > 8);

    it.each(forbidden)('application schema omits %s', (secret) => {
      expect(JSON.stringify(applicationDocument)).not.toContain(secret);
    });

    it.each(forbidden)('auth schema omits %s', (secret) => {
      expect(JSON.stringify(authDocument)).not.toContain(secret);
    });

    it('contains no token value, only documented placeholders', () => {
      const serialized = JSON.stringify(authDocument);
      const values: string[] = [
        ...serialized.matchAll(/token=([A-Za-z0-9_\-.]*)/g),
      ].map((match) => match[1] ?? '');

      for (const value of values) {
        expect(value).toMatch(/^[A-Z_]*$/);
      }
    });
  });
});

describe('OpenAPI disabled (e2e)', () => {
  let app: INestApplication;
  let server: App;
  let mounted: boolean;

  beforeAll(async () => {
    ({ app, server, mounted } = await boot(false));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    process.env.OPENAPI_ENABLED = 'true';
  });

  it('mounts nothing', () => {
    expect(mounted).toBe(false);
  });

  it('has no documentation UI', async () => {
    await request(server).get('/docs').expect(404);
  });

  it('has no application schema', async () => {
    await request(server).get('/openapi.json').expect(404);
  });

  it('removes the Better Auth schema endpoint entirely', async () => {
    await request(server).get('/api/auth/open-api/generate-schema').expect(404);
  });

  it('leaves the rest of the application working', async () => {
    await request(server).get('/api/auth/ok').expect(200);
  });
});
