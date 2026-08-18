import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, PinoLogger } from 'nestjs-pino';

import { appConfig } from './config';
import {
  ProcessReadiness,
  onTerminationSignal,
  runShutdownSequence,
} from './core/lifecycle';
import { OutboxDispatcher } from './core/outbox';
import { QueueProducer, QueueWorkerRunner } from './core/queue';
import { WorkerModule } from './worker.module';

/**
 * The worker process.
 *
 * An application *context*, not a server: it listens on no port, and the work it
 * does arrives from PostgreSQL and BullMQ rather than from a request. It runs
 * two things that are related but separate — the outbox dispatcher, which turns
 * committed rows into queue jobs, and the queue workers, which execute them.
 * Both live here because both need a Redis connection and neither belongs
 * anywhere near a request path.
 *
 * The dispatcher could be extracted to its own `src/dispatcher.ts` if delivery
 * ever needs to scale independently of execution. Nothing here prevents that:
 * it is started and stopped through its own interface, and a second process
 * running one is already safe, because the claim uses `FOR UPDATE SKIP LOCKED`
 * and delivery is idempotent by design.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  const readiness = app.get(ProcessReadiness);
  const producer = app.get(QueueProducer);
  const runner = app.get(QueueWorkerRunner);
  const dispatcher = app.get(OutboxDispatcher);
  const shutdownLogger = await app.resolve(PinoLogger);

  /**
   * Startup has an order, and it is the reverse of shutdown's.
   *
   * The producer's queues are constructed first, so BullMQ's handshake and Lua
   * script loading happen here — where a failure is a startup problem somebody
   * will see — rather than inside the dispatcher's first publish, where it would
   * look like a slow queue. The workers start next, and only then does the
   * dispatcher begin producing work for them.
   */
  producer.init();
  runner.start();
  dispatcher.start();
  readiness.markReady();

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.log(`Received ${signal}; draining worker`, 'Shutdown');

    const outcome = await runShutdownSequence(
      [
        {
          /**
           * First. The dispatcher is the only thing still *creating* work for
           * this process, and it waits for the pass in flight — so by the time
           * this returns, no publish is outstanding and the queue can be closed
           * without failing one.
           */
          name: 'stop-outbox-dispatcher',
          run: () => dispatcher.stop(),
        },
        {
          /**
           * No probe reads this yet — the worker serves no HTTP. It is set here
           * anyway, at the point the sequence says it should be, so that adding
           * a probe later is a matter of exposing state that has been maintained
           * correctly all along rather than retrofitting it onto a shutdown path
           * that never considered it.
           */
          name: 'mark-not-ready',
          run: () => readiness.markDraining(),
        },
        {
          /**
           * Stops claiming immediately, then lets the jobs already running
           * finish within `QUEUE_SHUTDOWN_GRACE_MS`, then closes — forcibly if
           * the grace period expired. Also closes `QueueEvents`, after the
           * workers, so the last failures are still recorded.
           *
           * No `QueueScheduler`: BullMQ folded it into `Worker` in v2, and
           * delayed and stalled jobs are handled by the worker itself.
           */
          name: 'close-queue-workers',
          run: () => runner.stop(),
        },
        {
          name: 'close-queue-producers',
          run: () => producer.close(),
        },
        {
          /**
           * Runs the module lifecycle hooks, which is what closes the general
           * Redis client and disconnects Prisma — each next to the resource it
           * owns rather than restated here. Last, because everything above still
           * needed one or the other.
           */
          name: 'close-application',
          run: () => app.close(),
        },
      ],
      { logger: shutdownLogger, timeoutMs: config.shutdown.timeoutMs },
    );

    /**
     * Nothing in that sequence writes business state, and that is the contract.
     *
     * A deployment is not a cancellation. A job abandoned when the grace period
     * expires keeps its durable record and is recovered as stalled by another
     * worker; marking runs `CANCELLED` on `SIGTERM` would destroy the only
     * distinction that matters — `CANCELLED` has to mean somebody decided the
     * work should not happen.
     */
    process.exit(outcome.failed.length > 0 ? 1 : 0);
  };

  onTerminationSignal((signal) => {
    void shutdown(signal);
  });

  logger.log(
    `Worker started NODE_ENV=${config.env} queues=[${runner.queueNames.join(', ')}]`,
    'Bootstrap',
  );
}

void bootstrap();
