import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';

// Application routes authenticate with Better Auth's session cookie.
// Do not advertise bearer auth unless bearer-token authentication is added.
const SESSION_COOKIE_SCHEME = 'sessionCookie';
const SESSION_COOKIE_NAME = '__Host-session';

/**
 * The Application OpenAPI document, built from Nest's route metadata.
 *
 * This is the single builder. `setupOpenApi` calls it to serve the document,
 * and Platform type generation calls it to read the same document off a
 * preview-mode application, so the served contract and the generated
 * TypeScript cannot describe different APIs.
 *
 * It reads metadata only: no listener, no database, no Redis, no provider.
 * The application name is a parameter rather than a configuration lookup
 * because a preview-mode application instantiates no providers, so there is
 * no configuration to read.
 */
export function createApplicationOpenApiDocument(
  app: INestApplication,
  applicationName: string,
): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      // Keep both OpenAPI sources on the same specification version.
      .setOpenAPIVersion('3.1.1')
      .setTitle(`${applicationName} — Application API`)
      .setDescription(
        'Application endpoints. Authentication, administration and ' +
          'organization protocol endpoints are documented by Better Auth ' +
          'under the "Authentication API" source.',
      )
      .setVersion('1.0.0')
      // The one place the global API prefix is declared. Keep in sync with
      // the prefix `main.ts` applies.
      .addServer('/api')
      .addCookieAuth(
        SESSION_COOKIE_NAME,
        { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE_NAME },
        SESSION_COOKIE_SCHEME,
      )
      .addSecurityRequirements(SESSION_COOKIE_SCHEME)
      .build(),
    // `main.ts` sets the global prefix before building the document, so Nest
    // would also stamp `/api` onto every path key and documented URLs would
    // resolve to `/api/api/...`. The server declares the prefix; paths stay
    // relative to it, matching how the Better Auth source is documented.
    { ignoreGlobalPrefix: true },
  );
}
