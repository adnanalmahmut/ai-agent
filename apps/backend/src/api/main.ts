import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, PinoLogger } from 'nestjs-pino';
import { setTimeout as delay } from 'node:timers/promises';

import { AppModule } from './app.module';
import { appConfig, httpConfig } from '../infrastructure/config';
import { setupOpenApi } from '../infrastructure/docs';
import { configureTrustedProxy } from '../infrastructure/http';
import {
  ProcessReadiness,
  onTerminationSignal,
  runShutdownSequence,
} from '../infrastructure/lifecycle';

const DRAIN_RESERVE_MS = 5_000;

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
  const http = app.get<ConfigType<typeof httpConfig>>(httpConfig.KEY);
  configureTrustedProxy(app, http);
  const readiness = app.get(ProcessReadiness);

  // No-op when OpenAPI is disabled.
  const docsMounted = setupOpenApi(app);

  await app.listen(config.port);
  readiness.markReady();

  // Transient provider, so `resolve` rather than `get`.
  const shutdownLogger = await app.resolve(PinoLogger);

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.log(`Received ${signal}; draining HTTP traffic`, 'Shutdown');

    const outcome = await runShutdownSequence(
      [
        {
          name: 'fail-readiness',
          run: () => readiness.markDraining(),
        },
        {
          name: 'await-load-balancer',
          run: (budget) =>
            delay(
              budget.allow(config.shutdown.readinessDelayMs, DRAIN_RESERVE_MS),
            ),
        },
        {
          name: 'close-application',
          run: () => app.close(),
        },
      ],
      { logger: shutdownLogger, timeoutMs: config.shutdown.timeoutMs },
    );

    process.exit(outcome.failed.length > 0 ? 1 : 0);
  };

  onTerminationSignal((signal) => {
    void shutdown(signal);
  });

  logger.log(
    `Server listening on port ${config.port} NODE_ENV=${config.env} docs=${docsMounted ? 'on' : 'off'}`,
    'Bootstrap',
  );
}

void bootstrap();
