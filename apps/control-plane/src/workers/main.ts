import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, PinoLogger } from 'nestjs-pino';

import { AgentRunReconciler } from '../ai/execution/agent-run-reconciler.service';
import { appConfig, queueConfig } from '../infrastructure/config';
import {
  ProcessReadiness,
  onTerminationSignal,
  runShutdownSequence,
} from '../infrastructure/lifecycle';
import { OutboxDispatcher } from '../infrastructure/outbox';
import { QueueProducer, QueueWorkerRunner } from '../infrastructure/queue';
import { WorkerModule } from './worker.module';
import { startWorkerRuntime } from './worker.runtime';
import { workerShutdownSteps } from './worker.shutdown';

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
