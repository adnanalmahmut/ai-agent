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
import { SideEffectExecutionHandler } from '../../../workers/handlers/side-effect-execution.handler';

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
    { provide: AGENT_CONTEXT, useExisting: AgentContextAssembler },
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
  /**
   * `ToolExecutionService` is exported for one read, not for its writers.
   *
   * The MCP adapter needs a session's durable tool-call count to enforce a
   * ceiling the gateway's per-`authorize` budget cannot reach across HTTP
   * requests. That query belongs to this service rather than being restated
   * against Prisma somewhere else. The lifecycle writers — `start`, `succeed`,
   * `fail`, `propose`, `claimEffectAttempt`, `settleEffect` — stay callable
   * only from the gateway and the side-effect handler, which is asserted by a
   * boundary test rather than left to convention.
   */
  exports: [
    ToolGateway,
    ToolExecutionService,
    AgentContextAssembler,
    AGENT_CONTEXT,
    SideEffectExecutionHandler,
  ],
})
export class AgentToolsModule {}
