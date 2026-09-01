import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database';
import { KnowledgeCoreModule } from '../../knowledge';
import { AgentContextAssembler } from '../agent-context.assembler';
import { KnowledgeSearchTool } from './knowledge-search.tool';
import { APPLICATION_TOOL_DEFINITIONS } from './definitions';
import { TOOL_DEFINITIONS, ToolRegistry } from './tool.registry';
import { ToolExecutionService } from './tool-execution.service';
import { TOOL_IMPLEMENTATIONS, ToolGateway } from './tool.gateway';
import type { ToolImplementation } from './tool.types';

/**
 * The governed tool boundary, composed once.
 *
 * `AgentContextAssembler` is provided here rather than alongside the runner
 * because `knowledge.search@1` is built on it and this module is the only
 * place that needs to construct it. Exported so the runner keeps using the
 * same instance: two assemblers would be two objects deciding what a tenant
 * may read, which is exactly one too many.
 */
@Module({
  imports: [DatabaseModule, KnowledgeCoreModule],
  providers: [
    { provide: TOOL_DEFINITIONS, useValue: APPLICATION_TOOL_DEFINITIONS },
    ToolRegistry,
    ToolExecutionService,
    AgentContextAssembler,
    KnowledgeSearchTool,
    {
      /**
       * Listed explicitly, not discovered.
       *
       * The gateway asserts that this list and the registry describe the same
       * set, so a tool added to one and forgotten in the other fails at
       * composition rather than on whichever run first calls it.
       */
      provide: TOOL_IMPLEMENTATIONS,
      useFactory: (knowledgeSearch: KnowledgeSearchTool): ToolImplementation[] => [
        knowledgeSearch,
      ],
      inject: [KnowledgeSearchTool],
    },
    ToolGateway,
  ],
  exports: [ToolGateway, ToolRegistry, AgentContextAssembler],
})
export class AgentToolsModule {}
