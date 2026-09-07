import { Module } from '@nestjs/common';

import { AgentDefinitionsModule } from '../../features/agent-management/agent-definitions.module';
import { AgentsModule } from '../../features/agent-management/agents.module';
import { AgentToolsModule } from '../../features/agent-management/tools/agent-tools.module';
import { DatabaseModule } from '../../infrastructure/database';
import { ExecutionStepAssembler } from './execution-step.assembler';
import { LeaseExecutionStepUseCase } from './lease-execution-step.use-case';
import { SettleExecutionStepUseCase } from './settle-execution-step.use-case';

/**
 * The composition root for the execution boundary. It names the modules that
 * hold durable authority; the use cases themselves name no transport.
 */
@Module({
  imports: [
    DatabaseModule,
    AgentsModule,
    AgentDefinitionsModule,
    AgentToolsModule,
  ],
  providers: [
    ExecutionStepAssembler,
    LeaseExecutionStepUseCase,
    SettleExecutionStepUseCase,
  ],
  exports: [LeaseExecutionStepUseCase, SettleExecutionStepUseCase],
})
export class ExecutionModule {}
