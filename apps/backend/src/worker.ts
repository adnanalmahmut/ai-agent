import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, PinoLogger } from 'nestjs-pino';

import { AgentRunReconciler } from './agents/agent-run-reconciler.service';
import { appConfig, queueConfig } from './config';
import {
  ProcessReadiness,
  onTerminationSignal,
  runShutdownSequence,
} from './core/lifecycle';
import { OutboxDispatcher } from './core/outbox';
import { QueueProducer, QueueWorkerRunner } from './core/queue';
import { WorkerModule } from './worker.module';
import { startWorkerRuntime } from './worker.runtime';
import { workerShutdownSteps } from './worker.shutdown';

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
  const queue = app.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  const readiness = app.get(ProcessReadiness);
  const producer = app.get(QueueProducer);
  const runner = app.get(QueueWorkerRunner);
  const dispatcher = app.get(OutboxDispatcher);
  const reconciler = app.get(AgentRunReconciler);
  const shutdownLogger = await app.resolve(PinoLogger);

  // Startup has an order, and it is the reverse of shutdown's. It lives in its
  // own module so a test can run the real sequence rather than a copy.
  startWorkerRuntime({ producer, runner, dispatcher, reconciler });

  readiness.markReady();

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.log(`Received ${signal}; draining worker`, 'Shutdown');

    const outcome = await runShutdownSequence(
      workerShutdownSteps({
        dispatcher,
        reconciler,
        readiness,
        runner,
        producer,
        closeApplication: () => app.close(),
        drainGraceMs: queue.shutdownGraceMs,
      }),
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
