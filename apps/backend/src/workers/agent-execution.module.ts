import { Module } from '@nestjs/common';

import {
  ControlPlaneCoreModule,
  RuntimeConfigResolver,
} from '../features/control-plane';
import { AI_RUNTIME_CONFIG } from '../ai/infrastructure/runtime-config.port';
import { MastraRuntime } from '../ai/infrastructure/runtimes/mastra/mastra.runtime';
import { AgentRunReconciler } from '../ai/execution/agent-run-reconciler.service';
import { AgentRunner } from '../ai/execution/agent-runner.service';
import { AgentRuntimeRegistry } from '../ai/execution/agent-runtime.registry';
import { DatabaseModule } from '../infrastructure/database';
import { QueueModule } from '../infrastructure/queue';
import { KnowledgeCoreModule } from '../features/knowledge';
import { AgentDefinitionsModule } from '../features/agent-management/agent-definitions.module';
import { AgentsModule } from '../features/agent-management/agents.module';
import { AgentToolsModule } from '../features/agent-management/tools/agent-tools.module';
import { AgentExecutionHandler } from './handlers/agent-execution.handler';
import { SideEffectExecutionHandler } from './handlers/side-effect-execution.handler';

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
    { provide: AI_RUNTIME_CONFIG, useExisting: RuntimeConfigResolver },
    MastraRuntime,
    AgentRuntimeRegistry,
    AgentRunner,
    AgentExecutionHandler,
    SideEffectExecutionHandler,
    AgentRunReconciler,
  ],
  /**
   * The handlers are exported so the worker root can register them beside the
   * knowledge embedding handler.
   */
  exports: [
    AgentExecutionHandler,
    SideEffectExecutionHandler,
    AgentRunReconciler,
  ],
})
export class AgentExecutionModule {}
