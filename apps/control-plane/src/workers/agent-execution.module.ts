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

@Module({
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
  exports: [
    AgentExecutionHandler,
    SideEffectExecutionHandler,
    AgentRunReconciler,
  ],
})
export class AgentExecutionModule {}
