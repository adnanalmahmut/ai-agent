import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';

import { appConfig, openapiConfig } from '../config';

// Application routes authenticate with Better Auth's session cookie.
// Do not advertise bearer auth unless bearer-token authentication is added.
const SESSION_COOKIE_SCHEME = 'sessionCookie';
const SESSION_COOKIE_NAME = '__Host-session';

export function setupOpenApi(app: INestApplication): boolean {
  const openapi = app.get<ConfigType<typeof openapiConfig>>(openapiConfig.KEY);

  if (!openapi.enabled) return false;

  const application = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      // Keep both OpenAPI sources on the same specification version.
      .setOpenAPIVersion('3.1.1')
      .setTitle(`${application.name} — Application API`)
      .setDescription(
        'Application endpoints. Authentication, administration and ' +
          'organization protocol endpoints are documented by Better Auth ' +
          'under the "Authentication API" source.',
      )
      .setVersion('1.0.0')
      // Keep in sync with the application's global API prefix.
      .addServer('/api')
      .addCookieAuth(
        SESSION_COOKIE_NAME,
        { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE_NAME },
        SESSION_COOKIE_SCHEME,
      )
      .addSecurityRequirements(SESSION_COOKIE_SCHEME)
      .build(),
  );

  // Expose only the JSON document; Scalar is the single documentation UI.
  SwaggerModule.setup('docs-app', app, document, {
    ui: false,
    raw: ['json'],
    jsonDocumentUrl: openapi.jsonPath,
  });

  // Relative URLs keep the docs origin-agnostic across environments.
  app.use(
    openapi.path,
    apiReference({
      pageTitle: `${application.name} API`,
      theme: 'purple',
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
