import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
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
  contentIdeaAvailabilitySchema,
  contentIdeaOperationSchema,
  requestContentIdeasSchema,
} from './content-idea.contract';
import { ContentIdeaService } from './content-idea.service';

const requestSchema = requestContentIdeasSchema;

class RequestContentIdeasDto extends createZodDto(requestSchema) {}

@ApiTags('Content ideas')
@Controller('organizations/:organizationId/content-ideas')
@UseGuards(OrganizationPermissionGuard)
export class ContentIdeaController {
  constructor(private readonly contentIdeas: ContentIdeaService) {}

  @Post()
  @RequiresOrganizationPermission({ contentIdea: ['create'] })
  @UserRateLimit({ points: 20, durationSec: 300 })
  @ApiOperation({
    operationId: 'requestContentIdeas',
    summary: 'Ask the content-idea agent for ideas',
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
  @ApiBody({ schema: wireSchemaOf(requestSchema) })
  @ApiCreatedResponse({ schema: apiSuccessSchema(contentIdeaOperationSchema) })
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

  @Get('availability')
  @RequiresOrganizationPermission({ contentIdea: ['read'] })
  @ApiOperation({
    operationId: 'getContentIdeaAvailability',
    summary: 'Whether this organization may currently generate content ideas',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiOkResponse({ schema: apiSuccessSchema(contentIdeaAvailabilitySchema) })
  availability(@Param('organizationId') organizationId: string) {
    return this.contentIdeas.availability({ organizationId });
  }

  @Get(':operationId')
  @RequiresOrganizationPermission({ contentIdea: ['read'] })
  @ApiOperation({
    operationId: 'getContentIdeaOperation',
    summary: 'Read the status and result of a content-idea request',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'operationId' })
  @ApiOkResponse({ schema: apiSuccessSchema(contentIdeaOperationSchema) })
  operation(
    @Param('organizationId') organizationId: string,
    @Param('operationId') operationId: string,
  ) {
    return this.contentIdeas.operation({ organizationId, runId: operationId });
  }
}
