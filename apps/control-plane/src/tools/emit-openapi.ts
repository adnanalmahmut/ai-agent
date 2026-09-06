/**
 * Writes the Application OpenAPI document to the path given as the first
 * argument.
 *
 * This exists so the Platform can generate TypeScript from the contract the
 * Backend authors, without a developer or CI runner having to serve the API
 * first. It is development tooling: nothing in the running application calls
 * it, and no deployment depends on it.
 *
 * Preview mode is what keeps this metadata work. Nest builds the module graph
 * and its route metadata but instantiates no providers, so there is no
 * listener, no database or Redis connection, no provider client, and no
 * configuration to validate — the command needs neither services nor secrets.
 */
import { NestFactory } from '@nestjs/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AppModule } from '../api/app.module';
import { DEFAULT_APPLICATION_NAME } from '../infrastructure/config';
import { createApplicationOpenApiDocument } from '../infrastructure/docs';

async function emit(outputPath: string): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Metadata only: no provider is constructed and no lifecycle hook runs.
    preview: true,
    logger: false,
    bodyParser: false,
  });

  try {
    // Mirror `api/main.ts`, which applies the prefix before the document is
    // built, so the emitted document is the one production serves.
    app.setGlobalPrefix('api');

    const document = createApplicationOpenApiDocument(
      app,
      // The generated types describe payloads, not the document's title, and
      // preview mode has no configuration to read `APP_NAME` from. Using the
      // documented default keeps the output identical on every machine.
      DEFAULT_APPLICATION_NAME,
    );

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

const outputPath = process.argv[2];

if (outputPath === undefined) {
  console.error('Usage: emit-openapi <output-path>');
  process.exit(1);
}

// Nothing keeps the event loop alive once the document is written, so the
// process ends on its own rather than being forced to.
void emit(outputPath).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
