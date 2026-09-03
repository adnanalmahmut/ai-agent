import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { z } from 'zod';

import {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from '../../../infrastructure/auth';
import { AppException } from '../../../core/errors';
import { createZodDto } from '../../../infrastructure/http';
import { UserRateLimit } from '../../../infrastructure/rate-limit';
import {
  contentProjectFromIdeaInput,
  ContentProjectService,
} from './content-project.service';

class CreateContentProjectFromIdeaDto extends createZodDto(
  contentProjectFromIdeaInput,
) {}

const idempotencyKeySchema = z.string().trim().min(8).max(200);

const listQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

class ListContentProjectsDto extends createZodDto(listQuerySchema) {}

@ApiTags('Content projects')
@Controller('organizations/:organizationId/content-projects')
@UseGuards(OrganizationPermissionGuard)
export class ContentProjectController {
  constructor(private readonly projects: ContentProjectService) {}

  @Post('from-idea')
  @RequiresOrganizationPermission({ contentProject: ['create'] })
  @UserRateLimit({ points: 60, durationSec: 300 })
  @ApiOperation({
    operationId: 'createContentProjectFromIdea',
    summary: 'Promote one generated idea into a content project',
  })
  @ApiParam({ name: 'organizationId' })
  createFromIdea(
    @Param('organizationId') organizationId: string,
    @Body() body: CreateContentProjectFromIdeaDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Session() session: UserSession,
  ) {
    const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey);

    if (!parsedKey.success) {
      throw new AppException('VALIDATION_ERROR', {
        context: { resource: 'contentProject', reason: 'idempotency_key' },
        publicDetails: {
          reason:
            'An Idempotency-Key header of at least 8 characters is required.',
        },
      });
    }

    return this.projects.createFromIdea({
      organizationId,
      actorUserId: session.user.id,
      idempotencyKey: parsedKey.data,
      payload: body,
    });
  }

  @Get()
  @RequiresOrganizationPermission({ contentProject: ['read'] })
  @ApiOperation({
    operationId: 'listContentProjects',
    summary: "List this organization's content projects, newest first",
  })
  @ApiParam({ name: 'organizationId' })
  list(
    @Param('organizationId') organizationId: string,
    @Query() query: ListContentProjectsDto,
  ) {
    return this.projects.list({
      organizationId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get(':projectId')
  @RequiresOrganizationPermission({ contentProject: ['read'] })
  @ApiOperation({
    operationId: 'getContentProject',
    summary: 'Read one content project and its drafts',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'projectId' })
  detail(
    @Param('organizationId') organizationId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.projects.detail({ organizationId, projectId });
  }
}
