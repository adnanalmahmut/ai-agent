import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { createZodDto } from '../../infrastructure/http';
import { UserRateLimit } from '../../infrastructure/rate-limit';
import { AppException } from '../../core/errors';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from '../../infrastructure/auth/organization-permission.guard';
import {
  KNOWLEDGE_SPACE_SLUGS,
  isKnowledgeSpaceSlug,
  type KnowledgeSpaceSlug,
} from './knowledge-space.registry';
import { KnowledgeSpaceService } from './knowledge-space.service';

function assertRegisteredSlug(value: string): KnowledgeSpaceSlug {
  if (!isKnowledgeSpaceSlug(value)) {
    throw new AppException('NOT_FOUND', {
      context: { resource: 'knowledgeSpace' },
    });
  }

  return value;
}

const listDocumentsSchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();
class ListDocumentsDto extends createZodDto(listDocumentsSchema) {}

const ingestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    sourceUri: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => !/^\s*(javascript|data|vbscript):/i.test(value), {
        message: 'A source reference may not use a script or data scheme',
      })
      .optional(),
    content: z
      .string()
      .min(1)
      .max(512 * 1_024),
  })
  .strict();
class IngestDocumentDto extends createZodDto(ingestSchema) {}

@ApiTags('Knowledge')
@Controller('organizations/:organizationId/knowledge')
@UseGuards(OrganizationPermissionGuard)
export class KnowledgeController {
  constructor(
    private readonly spaces: KnowledgeSpaceService,
    private readonly documents: KnowledgeIngestionService,
  ) {}

  @Get('spaces')
  @RequiresOrganizationPermission({ knowledge: ['read'] })
  @ApiOperation({
    operationId: 'listKnowledgeSpaces',
    summary:
      'List the canonical knowledge spaces and what this organization has stored',
  })
  @ApiParam({ name: 'organizationId' })
  listSpaces(@Param('organizationId') organizationId: string) {
    return this.spaces.list(organizationId);
  }

  @Delete('spaces/:slug')
  @RequiresOrganizationPermission({ knowledge: ['write'] })
  @ApiOperation({
    operationId: 'clearKnowledgeSpace',
    summary: 'Delete everything this organization has stored in one space',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'slug', enum: KNOWLEDGE_SPACE_SLUGS })
  clearSpace(
    @Param('organizationId') organizationId: string,
    @Param('slug') slug: string,
  ) {
    return this.spaces.remove({
      organizationId,
      slug: assertRegisteredSlug(slug),
    });
  }

  @Get('spaces/:slug/documents')
  @RequiresOrganizationPermission({ knowledge: ['read'] })
  @ApiOperation({
    operationId: 'listKnowledgeDocuments',
    summary: 'List one bounded page of the documents in a knowledge space',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'slug', enum: KNOWLEDGE_SPACE_SLUGS })
  listDocuments(
    @Param('organizationId') organizationId: string,
    @Param('slug') slug: string,
    @Query() query: ListDocumentsDto,
  ) {
    return this.documents.list({
      organizationId,
      slug: assertRegisteredSlug(slug),
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Put('spaces/:slug/documents')
  @RequiresOrganizationPermission({ knowledge: ['write'] })
  @UserRateLimit({ points: 60, durationSec: 300 })
  @ApiOperation({
    operationId: 'ingestKnowledgeDocument',
    summary: 'Create or replace a document by title',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'slug', enum: KNOWLEDGE_SPACE_SLUGS })
  ingest(
    @Param('organizationId') organizationId: string,
    @Param('slug') slug: string,
    @Body() body: IngestDocumentDto,
  ) {
    return this.documents.ingest({
      organizationId,
      slug: assertRegisteredSlug(slug),
      title: body.title,
      sourceUri: body.sourceUri,
      content: body.content,
    });
  }

  @Delete('documents/:documentId')
  @RequiresOrganizationPermission({ knowledge: ['write'] })
  @ApiOperation({
    operationId: 'deleteKnowledgeDocument',
    summary: 'Delete a document and its chunks',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'documentId' })
  deleteDocument(
    @Param('organizationId') organizationId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.documents.remove({ organizationId, documentId });
  }
}
