import { Module } from '@nestjs/common';

import { AgentsModule } from '../../agent-management';
import { OrganizationAccessModule } from '../../../infrastructure/auth';
import { ControlPlaneCoreModule } from '../../control-plane';
import { ContentIdeaController } from './content-idea.controller';
import { ContentIdeaService } from './content-idea.service';

/**
 * The content-idea feature, in the API composition root only.
 *
 * It accepts work and reads results; it does not execute anything. Running the
 * agent belongs to `AgentExecutionModule` in the worker, which is why nothing
 * here imports a runtime, a definition registry, or the knowledge domain — an
 * API process that could construct an agent would eventually be asked to run
 * one on the request thread.
 */
@Module({
  imports: [AgentsModule, ControlPlaneCoreModule, OrganizationAccessModule],
  controllers: [ContentIdeaController],
  providers: [ContentIdeaService],
  exports: [ContentIdeaService],
})
export class ContentIdeaModule {}
