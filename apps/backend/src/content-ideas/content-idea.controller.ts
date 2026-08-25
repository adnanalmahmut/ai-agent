import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { z } from 'zod';

import { contentIdeaInput } from '../agents';
import {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from '../core/auth';
import { AppException } from '../core/errors';
import { createZodDto } from '../core/http';
import { UserRateLimit } from '../core/rate-limit';
import { ContentIdeaService } from './content-idea.service';

/**
 * Content ideas, over HTTP.
 *
 * Two operations and no third. Generation is asynchronous because it is a
 * provider call that takes seconds and can fail, so the request returns an
 * operation and the caller polls it — there is deliberately no synchronous
 * variant, which would hold a connection open for the length of a model call
 * and give a timeout no retry could distinguish from a refusal.
 *
 * Authorization is the shared organization guard, so it runs before the body
 * is validated and answers about the organization in the path rather than the
 * session's active one.
 */

const requestSchema = contentIdeaInput;

class RequestContentIdeasDto extends createZodDto(requestSchema) {}

/**
 * Required, not optional.
 *
 * Generation costs money and is not naturally idempotent, so a client that
 * retried a timed-out request without a key would buy the same ideas twice.
 * Demanding the header makes that the client's explicit decision rather than
 * an accident of their HTTP library.
 */
const idempotencyKeySchema = z.string().trim().min(8).max(200);

@ApiTags('Content ideas')
@Controller('organizations/:organizationId/content-ideas')
@UseGuards(OrganizationPermissionGuard)
export class ContentIdeaController {
  constructor(private readonly contentIdeas: ContentIdeaService) {}

  @Post()
  @RequiresOrganizationPermission({ contentIdea: ['create'] })
  /**
   * Metered well below the generic budget: each accepted request is a queued
   * provider call against a credential the platform owns.
   */
  @UserRateLimit({ points: 20, durationSec: 300 })
  @ApiOperation({
    operationId: 'requestContentIdeas',
    summary: 'Ask the content-idea agent for ideas',
  })
  @ApiParam({ name: 'organizationId' })
  request(
    @Param('organizationId') organizationId: string,
    @Body() body: RequestContentIdeasDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Session() session: UserSession,
  ) {
    const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey);

    if (!parsedKey.success) {
      throw new AppException('VALIDATION_ERROR', {
        context: { resource: 'contentIdea', reason: 'idempotency_key' },
        publicDetails: {
          reason:
            'An Idempotency-Key header of at least 8 characters is required.',
        },
      });
    }

    return this.contentIdeas.request({
      organizationId,
      actorUserId: session.user.id,
      idempotencyKey: parsedKey.data,
      payload: body,
    });
  }

  @Get(':operationId')
  @RequiresOrganizationPermission({ contentIdea: ['read'] })
  @ApiOperation({
    operationId: 'getContentIdeaOperation',
    summary: 'Read the status and result of a content-idea request',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'operationId' })
  operation(
    @Param('organizationId') organizationId: string,
    @Param('operationId') operationId: string,
  ) {
    return this.contentIdeas.operation({ organizationId, runId: operationId });
  }
}
