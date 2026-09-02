import { Module } from '@nestjs/common';

import { NotificationDeliveryModule } from '../../core/mail/notification-delivery';
import { DatabaseModule } from '../../database';
import { KnowledgeCoreModule } from '../../knowledge';
import { AgentContextAssembler } from '../agent-context.assembler';
import { AgentDefinitionsModule } from '../agent-definitions.module';
import { KnowledgeSearchTool } from './knowledge-search.tool';
import { NotificationSendTool } from './notification-send.tool';
import { APPLICATION_TOOL_DEFINITIONS } from './definitions';
import { SideEffectExecutionHandler } from './side-effect-execution.handler';
import { TOOL_DEFINITIONS, ToolRegistry } from './tool.registry';
import { ToolExecutionService } from './tool-execution.service';
import { TOOL_IMPLEMENTATIONS, ToolGateway } from './tool.gateway';
import type { AnyToolImplementation } from './tool.types';

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
  /**
   * `NotificationDeliveryModule` and `AgentDefinitionsModule` are here for the
   * side-effect half: the notification tool delivers through the port, and the
   * worker handler re-resolves the pinned definition before it performs
   * anything. Both are pure composition — no HTTP, no queue consumer.
   */
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
    KnowledgeSearchTool,
    NotificationSendTool,
    {
      /**
       * Listed explicitly, not discovered.
       *
       * The gateway asserts that this list and the registry describe the same
       * set, so a tool added to one and forgotten in the other fails at
       * composition rather than on whichever run first calls it.
       */
      provide: TOOL_IMPLEMENTATIONS,
      useFactory: (
        knowledgeSearch: KnowledgeSearchTool,
        notificationSend: NotificationSendTool,
      ): AnyToolImplementation[] => [knowledgeSearch, notificationSend],
      inject: [KnowledgeSearchTool, NotificationSendTool],
    },
    ToolGateway,
    SideEffectExecutionHandler,
  ],
  exports: [ToolGateway, AgentContextAssembler, SideEffectExecutionHandler],
})
export class AgentToolsModule {}
