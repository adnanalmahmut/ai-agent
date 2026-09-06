import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { z } from 'zod';

import { RuntimeConfigResolver } from '../control-plane';
import { OutboxRepository } from '../../infrastructure/outbox';
import { AppException } from '../../core/errors';
import { PrismaService } from '../../infrastructure/database';
import { chunkDocument } from './chunking';
import {
  deletedKnowledgeDocumentSchema,
  documentListItemSchema,
  documentPageSchema,
  ingestedDocumentSchema,
} from './knowledge.contract';
import { isUniqueConstraintViolation } from '../../infrastructure/database';
import { KNOWLEDGE_DOCUMENT_INGESTED } from './knowledge.events';
import {
  decodeCursor,
  encodeCursor,
  pageSize,
  type DocumentCursor,
} from './knowledge-pagination';
import type { KnowledgeSpaceSlug } from './knowledge-space.registry';
import { KnowledgeSpaceService } from './knowledge-space.service';
import { EMBEDDING_PORT, type EmbeddingPort } from './ports/embedding.port';

export type IngestedDocument = z.output<typeof ingestedDocumentSchema>;

export type DocumentListItem = z.output<typeof documentListItemSchema>;

type DocumentPage = z.output<typeof documentPageSchema>;

type DeletedKnowledgeDocument = z.output<typeof deletedKnowledgeDocumentSchema>;

@Injectable()
export class KnowledgeIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    private readonly runtimeConfig: RuntimeConfigResolver,
    private readonly spaces: KnowledgeSpaceService,
    @Inject(EMBEDDING_PORT) private readonly embeddings: EmbeddingPort,
  ) {}

  async ingest(input: {
    organizationId: string;
    slug: KnowledgeSpaceSlug;
    title: string;
    sourceUri?: string;
    content: string;
  }): Promise<IngestedDocument> {
    await this.spaces.assertWritable(input.organizationId);

    const maxBytes = await this.runtimeConfig.setting(
      'knowledge.ingestion_max_document_bytes',
    );
    const byteLength = Buffer.byteLength(input.content, 'utf8');

    if (byteLength > maxBytes) {
      throw new AppException('VALIDATION_ERROR', {
        context: { resource: 'knowledgeDocument' },
        publicDetails: {
          reason: `The document is ${byteLength} bytes and the limit is ${maxBytes}.`,
        },
      });
    }

    const checksum = digestOf(input.content);
    const chunks = chunkDocument(input.content);

    if (chunks.length === 0) {
      throw new AppException('VALIDATION_ERROR', {
        context: { resource: 'knowledgeDocument' },
        publicDetails: { reason: 'The document has no text to store.' },
      });
    }

    const spaceId = await this.spaces.findId({
      organizationId: input.organizationId,
      slug: input.slug,
    });

    const existing =
      spaceId === null
        ? null
        : await this.prisma.knowledgeDocument.findFirst({
            where: {
              organizationId: input.organizationId,
              spaceId,
              title: input.title,
            },
            select: {
              id: true,
              checksum: true,
              revision: true,
              sourceUri: true,
              createdAt: true,
              updatedAt: true,
              _count: { select: { chunks: true } },
            },
          });

    if (existing !== null && existing.checksum === checksum) {
      const sourceUri = input.sourceUri ?? null;

      const written =
        sourceUri === existing.sourceUri
          ? undefined
          : (
              await this.prisma.knowledgeDocument.updateManyAndReturn({
                where: {
                  id: existing.id,
                  organizationId: input.organizationId,
                },
                data: { sourceUri },
                select: { sourceUri: true, updatedAt: true },
              })
            )[0];

      await this.requestEmbeddingRepair(existing.id, input.organizationId);

      return {
        id: existing.id,
        title: input.title,
        sourceUri: written?.sourceUri ?? sourceUri,
        checksum,
        revision: existing.revision,
        chunkCount: existing._count.chunks,
        changed: false,
        createdAt: existing.createdAt,
        updatedAt: written?.updatedAt ?? existing.updatedAt,
      };
    }

    const document = await this.runIngestion(async (tx) => {
      const { id: ensuredSpaceId } = await this.spaces.ensure({
        organizationId: input.organizationId,
        slug: input.slug,
        tx,
      });

      const saved = await tx.knowledgeDocument.upsert({
        where: {
          organizationId_spaceId_title: {
            organizationId: input.organizationId,
            spaceId: ensuredSpaceId,
            title: input.title,
          },
        },
        create: {
          organizationId: input.organizationId,
          spaceId: ensuredSpaceId,
          title: input.title,
          sourceUri: input.sourceUri ?? null,
          checksum,
        },
        update: {
          sourceUri: input.sourceUri ?? null,
          checksum,
          revision: { increment: 1 },
        },
        select: {
          id: true,
          revision: true,
          sourceUri: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await tx.knowledgeChunk.deleteMany({ where: { documentId: saved.id } });

      await tx.knowledgeChunk.createMany({
        data: chunks.map((chunk) => ({
          organizationId: input.organizationId,
          spaceId: ensuredSpaceId,
          documentId: saved.id,
          ordinal: chunk.ordinal,
          content: chunk.content,
        })),
      });

      await this.outbox.append(tx, {
        type: KNOWLEDGE_DOCUMENT_INGESTED,
        payload: {
          documentId: saved.id,
          organizationId: input.organizationId,
        },
        dedupeKey: `${saved.id}:${saved.revision}`,
      });

      return saved;
    });

    return {
      id: document.id,
      title: input.title,
      sourceUri: document.sourceUri,
      checksum,
      revision: document.revision,
      chunkCount: chunks.length,
      changed: true,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  async list(input: {
    organizationId: string;
    slug: KnowledgeSpaceSlug;
    cursor?: string;
    limit?: number;
  }): Promise<DocumentPage> {
    const take = pageSize(input.limit);
    const after =
      input.cursor === undefined ? null : decodeCursor(input.cursor);

    const spaceId = await this.spaces.findId({
      organizationId: input.organizationId,
      slug: input.slug,
    });

    if (spaceId === null) return { items: [], nextCursor: null };

    const rows = await this.prisma.knowledgeDocument.findMany({
      where: {
        organizationId: input.organizationId,
        spaceId,
        ...(after === null ? {} : afterPosition(after)),
      },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      take: take + 1,
      select: {
        id: true,
        title: true,
        sourceUri: true,
        checksum: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { chunks: true } },
      },
    });

    const items = rows.slice(0, take);
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        rows.length > take && last !== undefined
          ? encodeCursor({ title: last.title, id: last.id })
          : null,
    };
  }

  async remove(input: {
    organizationId: string;
    documentId: string;
  }): Promise<DeletedKnowledgeDocument> {
    const removed = await this.prisma.knowledgeDocument.deleteMany({
      where: { id: input.documentId, organizationId: input.organizationId },
    });

    if (removed.count === 0) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'knowledgeDocument' },
      });
    }

    return { id: input.documentId };
  }

  private async runIngestion<T>(
    work: (
      tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    ) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      throw new AppException('CONFLICT', {
        context: { resource: 'knowledgeDocument' },
      });
    }
  }

  private async requestEmbeddingRepair(
    documentId: string,
    organizationId: string,
  ): Promise<void> {
    const owed = await this.prisma.knowledgeChunk.count({
      where: {
        documentId,
        organizationId,
        OR: [
          { embeddingModel: null },
          { embeddingModel: { not: this.embeddings.model } },
        ],
      },
    });

    if (owed === 0) return;

    await this.outbox.append(this.prisma, {
      type: KNOWLEDGE_DOCUMENT_INGESTED,
      payload: { documentId, organizationId },
    });
  }
}

function afterPosition(after: DocumentCursor) {
  return {
    OR: [
      { title: { gt: after.title } },
      { title: after.title, id: { gt: after.id } },
    ],
  };
}

function digestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
