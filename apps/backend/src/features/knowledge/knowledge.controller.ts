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

/**
 * The organization's knowledge, over HTTP.
 *
 * Every route authorizes against the organization **in the path**, not against
 * the session's active one. `@MemberHasPermission` asks Better Auth about the
 * active organization, so a reader who belongs to two and has the other
 * selected would be answered about the wrong one — a bug that only appears for
 * people with more than one organization, which is to say in production.
 *
 * The check is a guard rather than a line in each handler, because Nest runs
 * guards before pipes: otherwise a caller with no access to the organization
 * would have their body parsed and validated first and receive a validation
 * error describing the request shape. `OrganizationPermissionGuard` also refuses
 * any route it finds unmarked, so forgetting the decorator closes a route
 * rather than opening one.
 *
 * Space and document ids are never trusted from the path either. Every service
 * call carries the organization id into its `where`, so an id belonging to
 * another organization matches nothing and answers 404 — the same answer a
 * non-existent id gets, which is what stops the surface from confirming that
 * another tenant's space exists.
 */

/**
 * Turns a path segment into a registry member, or answers 404.
 *
 * There is no slug *schema* any more, and no `name` a caller may submit. The
 * taxonomy is code-owned, so the only question this boundary asks is whether
 * the segment names a registered space — which makes an unknown slug
 * unpersistable through the application rather than merely discouraged. 404
 * rather than 400 because an unregistered slug names no resource, which is the
 * same answer a space belonging to another organization gets.
 */
function assertRegisteredSlug(value: string): KnowledgeSpaceSlug {
  if (!isKnowledgeSpaceSlug(value)) {
    throw new AppException('NOT_FOUND', {
      context: { resource: 'knowledgeSpace' },
    });
  }

  return value;
}

/**
 * Bounded, and both fields optional.
 *
 * `limit` arrives as a query string, so it is coerced before it is bounded;
 * the service refuses an out-of-range page rather than clamping it, because a
 * silently shortened page reads as the end of the collection.
 */
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
    /**
     * Free text and never dereferenced — this application does not fetch it.
     * A source can legitimately be a path, a ticket reference, or a sentence
     * naming where the text came from, so the shape is not constrained.
     *
     * What is refused is a scheme that only means anything to a browser. It is
     * returned by the listing, so the first screen that renders it as a link
     * would inherit whatever is stored here; `javascript:` and `data:` are
     * refused at the edge rather than left for that screen to remember.
     */
    sourceUri: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => !/^\s*(javascript|data|vbscript):/i.test(value), {
        message: 'A source reference may not use a script or data scheme',
      })
      .optional(),
    /**
     * The byte ceiling is the operator's, checked in the service against
     * `knowledge.ingestion_max_document_bytes`. This bound is only the
     * envelope, and it sits under the 1 MiB body limit the application parses
     * with: a body large enough to be a denial of service should be refused
     * before it is measured character by character.
     */
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

  /**
   * There is deliberately no route that *creates* a space.
   *
   * The eight spaces are the application's taxonomy, so the listing above
   * already returns all of them and a caller has nothing to add. Rows appear
   * when a document is first ingested into a space, inside that ingestion's own
   * transaction. What is left is emptying one, below.
   */
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

  /**
   * `PUT`, because ingestion is addressed by title and is idempotent: the same
   * text submitted twice is one document, unchanged the second time.
   */
  @Put('spaces/:slug/documents')
  @RequiresOrganizationPermission({ knowledge: ['write'] })
  /**
   * Metered on a burst window, because this request is not generic.
   *
   * Every accepted ingestion commits chunks and buys embeddings against a
   * credential the platform owns, so the default per-minute allowance is a
   * standing authorization for one organization admin to spend a great deal of
   * somebody else's money. The window is five minutes rather than one because
   * the honest usage pattern is bursty — seeding a knowledge base is dozens of
   * documents in a row, then nothing for a week — and a per-minute cap tight
   * enough to matter would refuse the one thing people legitimately do. Sixty
   * per five minutes absorbs the burst and still holds the sustained rate to a
   * twelfth of what a loop would want.
   */
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
