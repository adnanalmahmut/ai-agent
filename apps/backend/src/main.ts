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

  // API routes live under /api for path-based reverse-proxy routing.
  // Better Auth keeps its own /api/auth path and is excluded from the global prefix.
  app.setGlobalPrefix('api');
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);

  // No-op when OpenAPI is disabled.
  const docsMounted = setupOpenApi(app);

  await app.listen(config.port);

  logger.log(
    `Server listening on port ${config.port} NODE_ENV=${config.env} docs=${docsMounted ? 'on' : 'off'}`,
    'Bootstrap',
  );
}

void bootstrap();
