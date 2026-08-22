import { Module } from '@nestjs/common';

import { QueueModule } from '../core/queue';
import {
  AGENT_DEFINITIONS,
  AgentDefinitionRegistry,
} from './agent-definition.registry';
import { AgentExecutionHandler } from './agent-execution.handler';
import { AgentRunReconciler } from './agent-run-reconciler.service';
import { AgentRunner } from './agent-runner.service';
import { AgentRuntimeRegistry } from './agent-runtime.registry';
import { AgentsModule } from './agents.module';
import { PRODUCTION_AGENT_DEFINITIONS } from './definitions';
import { MastraRuntime } from './runtime/mastra/mastra.runtime';

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
  imports: [AgentsModule, QueueModule],
  providers: [
    { provide: AGENT_DEFINITIONS, useValue: PRODUCTION_AGENT_DEFINITIONS },
    AgentDefinitionRegistry,
    MastraRuntime,
    AgentRuntimeRegistry,
    AgentRunner,
    AgentExecutionHandler,
    AgentRunReconciler,
  ],
  exports: [AgentExecutionHandler, AgentRunReconciler],
})
export class AgentExecutionModule {}
