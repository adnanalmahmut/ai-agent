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
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';

import {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from '../../../infrastructure/auth';
import { AppException } from '../../../core/errors';
import {
  apiSuccessSchema,
  createZodDto,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  wireSchemaOf,
} from '../../../infrastructure/http';
import { UserRateLimit } from '../../../infrastructure/rate-limit';
import {
  contentProjectDetailSchema,
  contentProjectPageSchema,
  listContentProjectsQuerySchema,
} from './content-project.contract';
import {
  contentProjectFromIdeaInput,
  ContentProjectService,
} from './content-project.service';

class CreateContentProjectFromIdeaDto extends createZodDto(
  contentProjectFromIdeaInput,
) {}

const listQuerySchema = listContentProjectsQuerySchema;

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
  // The request body is described by the schema that already validates it.
  // Required, and validated against the same schema the handler parses it
  // with, so the document cannot describe bounds the endpoint does not hold.
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    schema: wireSchemaOf(idempotencyKeySchema),
  })
  @ApiBody({ schema: wireSchemaOf(contentProjectFromIdeaInput) })
  @ApiCreatedResponse({ schema: apiSuccessSchema(contentProjectDetailSchema) })
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
  // Names, optionality and value semantics come from the same Zod schema that
  // validates the query, so the two cannot describe different things.
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: wireSchemaOf(listQuerySchema.shape.cursor),
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: wireSchemaOf(listQuerySchema.shape.limit),
  })
  @ApiOkResponse({ schema: apiSuccessSchema(contentProjectPageSchema) })
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
  @ApiOkResponse({ schema: apiSuccessSchema(contentProjectDetailSchema) })
  detail(
    @Param('organizationId') organizationId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.projects.detail({ organizationId, projectId });
  }
}
