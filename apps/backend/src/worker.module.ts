import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { appConfig, configurations, observabilityConfig } from './config';
import { LifecycleModule } from './core/lifecycle';
import { createLoggerOptions } from './core/providers/logger.options';
import { DatabaseModule } from './database';
import { OutboxModule } from './infrastructure/outbox';
import { QueueModule } from './infrastructure/queue';
import { RedisModule } from './infrastructure/redis';

/**
 * The worker process's composition root.
 *
 * Deliberately not `AppModule` with a flag. What each process must be *unable*
 * to do is as much of the design as what it does, and a shared module with a
 * conditional gives neither: the API would still be one injection away from a
 * queue producer in a request handler, and the worker would carry an HTTP
 * pipeline, a global auth guard and a Swagger document it never serves.
 *
 * So the two roots overlap only where the overlap is real — configuration,
 * logging, lifecycle state, PostgreSQL, Redis — and diverge above that.
 * `AppModule` adds the HTTP boundary, authentication and mail; this adds the
 * queue and the outbox dispatcher, which is the half that turns committed rows
 * into running work.
 *
 * What is absent is worth stating, because each absence prevents a specific
 * mistake:
 *
 *   No `AppI18nModule`         Locale is a property of a request, and a job has
 *                              no request. Work that needs one carries it in its
 *                              payload, which is also what makes it correct
 *                              after a retry on a different machine.
 *   No `HttpInfrastructureModule`
 *                              There is no HTTP boundary here to configure.
 *   No `AppAuthModule`         Authorization was decided when the request was
 *                              accepted. Re-deriving it in a worker from a
 *                              session that may since have been revoked would be
 *                              a second, weaker answer to a question already
 *                              answered.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: configurations,
    }),
    LoggerModule.forRootAsync({
      inject: [appConfig.KEY, observabilityConfig.KEY],
      useFactory: createLoggerOptions,
    }),
    LifecycleModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    OutboxModule,
  ],
})
export class WorkerModule {}
