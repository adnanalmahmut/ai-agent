import { Module } from '@nestjs/common';

import { QueueModule } from '../core/queue';
import { ControlPlaneCoreModule } from '../control-plane';
import { DatabaseModule } from '../database';
import { KnowledgeCoreModule } from '../knowledge';
import { AgentDefinitionsModule } from './agent-definitions.module';
import { AgentExecutionHandler } from './agent-execution.handler';
import { AgentRunReconciler } from './agent-run-reconciler.service';
import { AgentRunner } from './agent-runner.service';
import { AgentRuntimeRegistry } from './agent-runtime.registry';
import { AgentsModule } from './agents.module';
import { MastraRuntime } from './runtime/mastra/mastra.runtime';
import { AgentToolsModule } from './tools/agent-tools.module';

/**
 * Worker-only composition for durable background agent execution.
 *
 * `QueueModule` is imported for the reconciler, which asks the transport
 * whether a stranded run's job has terminally failed. It brings a queue
 * *producer*, not a consumer: consumption still requires a handler registered
 * through `QUEUE_JOB_HANDLERS`, which only `WorkerModule` does. And because
 * nothing imports this module but `WorkerModule`, the API composition root
 * gains neither.
 */
@Module({
  /**
   * `KnowledgeCoreModule` and `ControlPlaneCoreModule` arrive here, in the
   * worker's composition, because that is where an agent actually runs.
   * Context is assembled when the run executes rather than snapshotted when it
   * was accepted, and the provider credential is resolved at the same moment,
   * so neither is stale by the time it is used.
   *
   * The *core* modules specifically. Their controller-bearing siblings would
   * bring the HTTP stack — guards, interceptors, and the Redis-backed rate
   * limiter — into a process that serves no requests.
   */
  imports: [
    AgentsModule,
    QueueModule,
    DatabaseModule,
    KnowledgeCoreModule,
    ControlPlaneCoreModule,
    AgentDefinitionsModule,
    AgentToolsModule,
  ],
  providers: [
    MastraRuntime,
    AgentRuntimeRegistry,
    AgentRunner,
    AgentExecutionHandler,
    AgentRunReconciler,
  ],
  exports: [AgentExecutionHandler, AgentRunReconciler],
})
export class AgentExecutionModule {}
