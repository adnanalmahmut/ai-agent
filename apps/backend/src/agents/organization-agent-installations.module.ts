import { Module } from '@nestjs/common';

import { OrganizationAccessModule } from '../core/auth/organization-access.module';
import { DatabaseModule } from '../database';
import { AgentDefinitionsModule } from './agent-definitions.module';
import { OrganizationAgentInstallationController } from './organization-agent-installation.controller';
import { OrganizationAgentInstallationService } from './organization-agent-installation.service';

@Module({
  imports: [DatabaseModule, OrganizationAccessModule, AgentDefinitionsModule],
  controllers: [OrganizationAgentInstallationController],
  providers: [OrganizationAgentInstallationService],
  exports: [OrganizationAgentInstallationService],
})
export class OrganizationAgentInstallationsModule {}
