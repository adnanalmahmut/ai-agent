import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import {
  appConfig,
  observabilityConfig,
  workerConfigurations,
} from '../infrastructure/config';
import { ControlPlaneCoreModule } from '../features/control-plane';
import {
  KnowledgeCoreModule,
  KnowledgeEmbeddingHandler,
} from '../features/knowledge';
import { LifecycleModule } from '../infrastructure/lifecycle';
import { OutboxModule } from '../infrastructure/outbox';
import { createLoggerOptions } from '../infrastructure/providers/logger.options';
import {
  QUEUE_JOB_HANDLERS,
  QueueModule,
  QueueWorkerRunner,
  type QueueJobHandler,
} from '../infrastructure/queue';
import { RedisModule } from '../infrastructure/redis';
import { DatabaseModule } from '../infrastructure/database';
import { AgentExecutionHandler } from './handlers/agent-execution.handler';
import { SideEffectExecutionHandler } from './handlers/side-effect-execution.handler';
import { AgentExecutionModule } from './agent-execution.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: workerConfigurations,
    }),
    LoggerModule.forRootAsync({
      inject: [appConfig.KEY, observabilityConfig.KEY],
      useFactory: createLoggerOptions,
    }),
    LifecycleModule,
    DatabaseModule,
    // Without the controller: this process serves no HTTP. An agent execution
    // resolves its provider credential here, at the moment it runs, rather
    // than receiving one in a job payload that would sit in Redis and be as
    // stale as the moment it was enqueued.
    ControlPlaneCoreModule,
    // Here for the same reason: an agent assembles its context when it runs,
    // from whatever the organization's material says then — not from a
    // snapshot taken when the run was accepted.
    KnowledgeCoreModule,
    RedisModule,
    QueueModule,
    OutboxModule,
    AgentExecutionModule,
  ],
  providers: [
    QueueWorkerRunner,
    {
      provide: QUEUE_JOB_HANDLERS,
      inject: [
        AgentExecutionHandler,
        KnowledgeEmbeddingHandler,
        SideEffectExecutionHandler,
      ],
      useFactory: (
        agentExecution: AgentExecutionHandler,
        knowledgeEmbedding: KnowledgeEmbeddingHandler,
        sideEffect: SideEffectExecutionHandler,
      ): QueueJobHandler[] => [agentExecution, knowledgeEmbedding, sideEffect],
    },
  ],
})
export class WorkerModule {}
