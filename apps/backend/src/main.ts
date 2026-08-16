import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { appConfig } from './config';
import { setupOpenApi } from './core/docs';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.disable('x-powered-by');

  /**
   * Everything this application serves lives under `/api`.
   *
   * Production puts all three applications on one origin behind one reverse
   * proxy — `/` for the web application, `/platform/*` for the Platform,
   * `/api/*` for this one — so the prefix is what makes routing by path
   * possible without rewriting requests.
   *
   * Better Auth is already excluded: `@thallesp/nestjs-better-auth` appends
   * its own base path (`/api/auth`) to the global-prefix exclude list at
   * construction, so it keeps serving exactly where `BETTER_AUTH_URL` says it
   * does rather than moving to `/api/api/auth`.
   *
   * The documentation routes are unaffected too — Scalar is mounted with
   * `app.use()` and Swagger's JSON with `useGlobalPrefix` off — so `/docs`
   * stays where it is.
   */
  app.setGlobalPrefix('api');
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);

  // Mounts /docs and /openapi.json, or does nothing at all when
  // OPENAPI_ENABLED is off — which is the default in production.
  const docsMounted = setupOpenApi(app);

  await app.listen(config.port);

  logger.log(
    `Server listening on port ${config.port} NODE_ENV=${config.env} docs=${docsMounted ? 'on' : 'off'}`,
    'Bootstrap',
  );
}

void bootstrap();
