import { Module } from '@nestjs/common';

import { OrganizationAccessModule } from '../../../infrastructure/auth';
import { ControlPlaneModule } from '../../control-plane';
import { DatabaseModule } from '../../../infrastructure/database';
import { AgentDefinitionsModule } from '../agent-definitions.module';
import { RunAcceptanceModule } from '../../../modules/runs';
import { AgentsModule } from '../agents.module';
import { AgentToolsModule } from '../tools/agent-tools.module';
import { McpSessionController } from './mcp-session.controller';
import { McpSessionService } from './mcp-session.service';

@Module({
  imports: [
    DatabaseModule,
    // The shared organization guard's collaborator. The same module the
    // approval controller imports, for the same guard.
    OrganizationAccessModule,
    AgentsModule,
    RunAcceptanceModule,
    AgentDefinitionsModule,
    AgentToolsModule,
    ControlPlaneModule,
  ],
  controllers: [McpSessionController],
  providers: [McpSessionService],
})
export class McpModule {}
