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
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { z } from 'zod';

import {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from '../core/auth';
import { AppException } from '../core/errors';
import { createZodDto } from '../core/http';
import { UserRateLimit } from '../core/rate-limit';
import {
  contentProjectFromIdeaInput,
  ContentProjectService,
  MAX_CONTENT_PROJECT_PAGE_SIZE,
} from './content-project.service';

/**
 * Content projects, over HTTP.
 *
 * Three operations. Creation is synchronous — unlike asking for ideas, this
 * spends no provider call and writes two rows in one transaction, so there is
 * nothing to poll and an operation resource would be ceremony.
 *
 * Authorization is the shared organization guard, so it runs before the body is
 * validated and answers about the organization in the path rather than the
 * session's active one.
 */

class CreateContentProjectFromIdeaDto extends createZodDto(
  contentProjectFromIdeaInput,
) {}

/**
 * Required, not optional.
 *
 * Selecting an idea is not naturally idempotent: a client that retried a
 * timed-out request without a key would promote the same idea twice and leave
 * the organization two projects to reconcile by hand. Demanding the header
 * makes deduplication the client's explicit decision rather than an accident of
 * their HTTP library.
 */
const idempotencyKeySchema = z.string().trim().min(8).max(200);

const listQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_CONTENT_PROJECT_PAGE_SIZE)
      .optional(),
  })
  .strict();

@ApiTags('Content projects')
@Controller('organizations/:organizationId/content-projects')
@UseGuards(OrganizationPermissionGuard)
export class ContentProjectController {
  constructor(private readonly projects: ContentProjectService) {}

  @Post('from-idea')
  @RequiresOrganizationPermission({ contentProject: ['create'] })
  /**
   * Metered, though not as tightly as generation: this writes rows rather than
   * buying tokens. The ceiling is here so a loop cannot fill a tenant's list
   * with projects faster than a person could notice.
   */
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
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  list(
    @Param('organizationId') organizationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const parsed = listQuerySchema.safeParse(query);

    if (!parsed.success) {
      throw new AppException('VALIDATION_ERROR', {
        context: { resource: 'contentProject', reason: 'query' },
        publicDetails: {
          issues: parsed.error.issues.map((issue) => issue.message),
        },
      });
    }

    return this.projects.list({ organizationId, ...parsed.data });
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
