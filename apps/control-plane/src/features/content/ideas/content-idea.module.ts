import { Module } from '@nestjs/common';

import { AgentsModule } from '../../agent-management';
import { OrganizationAccessModule } from '../../../infrastructure/auth';
import { ControlPlaneCoreModule } from '../../control-plane';
import { ContentIdeaController } from './content-idea.controller';
import { ContentIdeaService } from './content-idea.service';

@Module({
  imports: [AgentsModule, ControlPlaneCoreModule, OrganizationAccessModule],
  controllers: [ContentIdeaController],
  providers: [ContentIdeaService],
  exports: [ContentIdeaService],
})
export class ContentIdeaModule {}
