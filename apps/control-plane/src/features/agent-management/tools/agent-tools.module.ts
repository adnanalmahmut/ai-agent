import { Module } from '@nestjs/common';

import { NotificationDeliveryModule } from '../../../infrastructure/mail/notification-delivery';
import { DatabaseModule } from '../../../infrastructure/database';
import { KnowledgeCoreModule } from '../../knowledge';
import { AGENT_CONTEXT } from '../../../ai/execution/agent-context.port';
import { ToolExecutionService } from '../../../ai/tools/tool-execution.service';
import {
  TOOL_IMPLEMENTATIONS,
  ToolGateway,
} from '../../../ai/tools/tool.gateway';
import {
  TOOL_DEFINITIONS,
  ToolRegistry,
} from '../../../ai/tools/tool.registry';
import type { AnyToolImplementation } from '../../../ai/tools/tool.types';
import { AgentContextAssembler } from '../../knowledge/agent-context.assembler';
import { AgentDefinitionsModule } from '../agent-definitions.module';
import { KnowledgeSearchTool } from '../../knowledge/tools/knowledge-search.tool';
import { NotificationSendTool } from './notification-send.tool';
import { APPLICATION_TOOL_DEFINITIONS } from './definitions';

@Module({
  imports: [
    DatabaseModule,
    KnowledgeCoreModule,
    NotificationDeliveryModule,
    AgentDefinitionsModule,
  ],
  providers: [
    { provide: TOOL_DEFINITIONS, useValue: APPLICATION_TOOL_DEFINITIONS },
    ToolRegistry,
    ToolExecutionService,
    AgentContextAssembler,
    { provide: AGENT_CONTEXT, useExisting: AgentContextAssembler },
    KnowledgeSearchTool,
    NotificationSendTool,
    {
      provide: TOOL_IMPLEMENTATIONS,
      useFactory: (
        knowledgeSearch: KnowledgeSearchTool,
        notificationSend: NotificationSendTool,
      ): AnyToolImplementation[] => [knowledgeSearch, notificationSend],
      inject: [KnowledgeSearchTool, NotificationSendTool],
    },
    ToolGateway,
  ],
  exports: [
    ToolGateway,
    ToolExecutionService,
    AgentContextAssembler,
    AGENT_CONTEXT,
    ToolRegistry,
    TOOL_IMPLEMENTATIONS,
  ],
})
export class AgentToolsModule {}
