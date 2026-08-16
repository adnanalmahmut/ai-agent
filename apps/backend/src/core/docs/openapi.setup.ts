import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';

import { appConfig, openapiConfig } from '../../config';

/**
 * The session cookie Better Auth issues, and the only credential this
 * application's own routes accept.
 *
 * Documented as an api-key-in-cookie scheme rather than bearer auth: the
 * `bearer()` plugin is not installed, so no application route reads an
 * `Authorization` header, and advertising one would be documentation that
 * lies. Better Auth's own document describes its own schemes; we do not edit
 * it.
 */
const SESSION_COOKIE_SCHEME = 'sessionCookie';
const SESSION_COOKIE_NAME = 'better-auth.session_token';

/**
 * One documentation experience, two schema sources.
 *
 * The two documents are *not* merged, for reasons that are properties of the
 * artifacts rather than preferences: they are produced at different times (the
 * Nest document at bootstrap from decorator metadata, Better Auth's at request
 * time from its live plugin list), they both define `User` and `Session`
 * component schemas, they both define a `bearerAuth` security scheme, Better
 * Auth tags its core routes `Default`, and their `servers` differ — Better
 * Auth's paths are relative to `/api/auth`, ours to `/`. A merge would need a
 * rename strategy for all of that, and renames break `$ref`s. Scalar renders
 * multiple sources natively with a document selector, so the user-facing goal
 * — one place to read the API — is met without any of it.
 *
 * Returns `false` when documentation is disabled, so callers and tests can
 * assert that nothing was mounted.
 */
export function setupOpenApi(app: INestApplication): boolean {
  const openapi = app.get<ConfigType<typeof openapiConfig>>(openapiConfig.KEY);
  if (!openapi.enabled) return false;

  const application = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      // Matches the 3.1.1 Better Auth's generator emits, so both sources in
      // the same UI speak the same dialect.
      .setOpenAPIVersion('3.1.1')
      .setTitle(`${application.name} — Application API`)
      .setDescription(
        'Application endpoints. Authentication, administration and ' +
          'organization protocol endpoints are documented by Better Auth ' +
          'under the "Authentication API" source.',
      )
      .setVersion('1.0.0')
      // Matches `setGlobalPrefix('api')` in main.ts: every application route
      // is served under it, so a document that claimed `/` would produce
      // "try it" requests that 404.
      .addServer('/api')
      .addCookieAuth(
        SESSION_COOKIE_NAME,
        { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE_NAME },
        SESSION_COOKIE_SCHEME,
      )
      .addSecurityRequirements(SESSION_COOKIE_SCHEME)
      .build(),
  );

  // `ui: false` is what keeps this to one documentation UI. Swagger UI would
  // otherwise be served alongside Scalar and the two would drift.
  SwaggerModule.setup('docs-app', app, document, {
    ui: false,
    raw: ['json'],
    jsonDocumentUrl: openapi.jsonPath,
  });

  // Relative source URLs: Scalar fetches them from the browser, so they
  // resolve against whatever origin the docs are being read from and no host
  // is baked into the build.
  app.use(
    openapi.path,
    apiReference({
      pageTitle: `${application.name} API`,
      sources: [
        {
          title: 'Application API',
          slug: 'application',
          url: openapi.jsonPath,
          default: true,
        },
        {
          title: 'Authentication API',
          slug: 'authentication',
          url: openapi.authSchemaPath,
        },
      ],
    }),
  );

  return true;
}
