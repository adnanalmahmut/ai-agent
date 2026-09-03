import { Module } from '@nestjs/common';

import { OrganizationAccessModule } from '../../../infrastructure/auth';
import { ControlPlaneModule } from '../../control-plane';
import { DatabaseModule } from '../../../infrastructure/database';
import { AgentDefinitionsModule } from '../agent-definitions.module';
import { AgentsModule } from '../agents.module';
import { AgentToolsModule } from '../tools/agent-tools.module';
import { McpSessionController } from './mcp-session.controller';
import { McpSessionService } from './mcp-session.service';

/**
 * The MCP adapter, composed from parts that already existed.
 *
 * Every import here is something the Mastra path also uses: the same run
 * acceptance, the same code-owned definitions, the same tool gateway, the same
 * control plane. Nothing in this module provides a tool, a registry, a grant,
 * or a way to record an execution — which is the composition-level statement
 * of the design. If MCP were a second backend, this module would have to
 * provide those, and it cannot.
 *
 * `AgentToolsModule` brings `ToolGateway` and `ToolExecutionService`; the
 * gateway is the authority and the service is consulted only for the session's
 * durable call count.
 */
@Module({
  imports: [
    DatabaseModule,
    // The shared organization guard's collaborator. The same module the
    // approval controller imports, for the same guard.
    OrganizationAccessModule,
    AgentsModule,
    AgentDefinitionsModule,
    AgentToolsModule,
    ControlPlaneModule,
  ],
  controllers: [McpSessionController],
  providers: [McpSessionService],
})
export class McpModule {}
