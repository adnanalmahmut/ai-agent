import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';

import { appConfig, openapiConfig } from '../config';
import { createApplicationOpenApiDocument } from './application-document';

export { createApplicationOpenApiDocument } from './application-document';

export function setupOpenApi(app: INestApplication): boolean {
  const openapi = app.get<ConfigType<typeof openapiConfig>>(openapiConfig.KEY);

  if (!openapi.enabled) return false;

  const application = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);

  const document = createApplicationOpenApiDocument(app, application.name);

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
