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

/**
 * Held back from the load-balancer pause, so draining in-flight requests and
 * closing the database pool always have some of the deadline left.
 */
const DRAIN_RESERVE_MS = 5_000;

/**
 * The API process.
 *
 * Serves HTTP and writes to PostgreSQL. It holds no BullMQ connection and needs
 * none: accepting asynchronous work means writing the business row and an
 * `outbox_event` in one transaction and returning, so a request cannot fail
 * because Redis is unwell, and there is no window in which a job exists for a
 * row that does not. The worker process (`src/workers/main.ts`) does the delivering.
 */
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

  /**
   * The drain sequence. Nest's own `enableShutdownHooks` is deliberately not
   * used: it installs signal handlers that call `app.close()` immediately, and
   * `app.close()` is the *last* step here, not the first. Running it first would
   * close the listener while the load balancer still believed this instance was
   * healthy, cutting off requests already on their way. The module hooks
   * themselves still run, because `app.close()` runs them whoever calls it.
   */
  const shutdown = async (signal: NodeJS.Signals) => {
    logger.log(`Received ${signal}; draining HTTP traffic`, 'Shutdown');

    const outcome = await runShutdownSequence(
      [
        {
          /**
           * First, and on its own. Readiness has to fail *before* anything
           * stops working, so the load balancer removes this instance while it
           * is still able to serve the requests already in flight.
           */
          name: 'fail-readiness',
          run: () => readiness.markDraining(),
        },
        {
          /**
           * The gap between "the probe fails" and "the listener closes".
           *
           * Endpoint removal is asynchronous — a kubelet that has not yet run
           * its next readiness probe is still routing here — so without this
           * pause the previous step is advisory. Zero outside a real
           * deployment, where there is no load balancer to inform.
           *
           * Drawn from the one process-wide budget and holding a reserve back,
           * so a generous `APP_SHUTDOWN_READINESS_DELAY_MS` can never leave the
           * actual request drain with no time at all.
           */
          name: 'await-load-balancer',
          run: (budget) =>
            delay(
              budget.allow(config.shutdown.readinessDelayMs, DRAIN_RESERVE_MS),
            ),
        },
        {
          /**
           * Closes the listener and drains what is in flight, then runs the
           * module lifecycle hooks in reverse dependency order — which is what
           * disconnects Prisma and closes the Redis client, each next to the
           * resource it owns rather than restated here.
           */
          name: 'close-application',
          run: () => app.close(),
        },
      ],
      { logger: shutdownLogger, timeoutMs: config.shutdown.timeoutMs },
    );

    /**
     * Explicit, because a clean sequence does not guarantee an empty event
     * loop: a stray timer or a socket a library forgot would otherwise leave
     * the process alive until the orchestrator killed it, which looks exactly
     * like a shutdown that hung.
     */
    process.exit(outcome.failed.length > 0 ? 1 : 0);
  };

  /**
   * Registered after `shutdown` exists, and only once: the helper ignores every
   * signal after the first, so an orchestrator that sends a second `SIGTERM` to
   * a process it considers slow does not start a second concurrent sequence
   * closing the same connections.
   */
  onTerminationSignal((signal) => {
    void shutdown(signal);
  });

  logger.log(
    `Server listening on port ${config.port} NODE_ENV=${config.env} docs=${docsMounted ? 'on' : 'off'}`,
    'Bootstrap',
  );
}

void bootstrap();
