import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { RuntimeConfigResolver } from '../control-plane';
import { OutboxRepository } from '../core/outbox';
import { AppException } from '../core/errors';
import { PrismaService } from '../database';
import { chunkDocument } from './chunking';
import { isUniqueConstraintViolation } from './prisma-errors';
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

export type IngestedDocument = {
  id: string;
  title: string;
  sourceUri: string | null;
  checksum: string;
  revision: number;
  chunkCount: number;
  /** False when the submitted text matched what was already stored. */
  changed: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** One row of a document listing, with the chunk count the screen shows. */
export type DocumentListItem = {
  id: string;
  title: string;
  sourceUri: string | null;
  checksum: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  _count: { chunks: number };
};

/**
 * Turning submitted text into embedded, retrievable passages.
 *
 * Content-addressed. A document is identified within its space by title, and
 * its body by a digest of the text; re-submitting identical text is a no-op
 * that costs nothing, and changed text replaces the whole chunk set. That
 * replacement *is* the versioning story, and there is deliberately no revision
 * history table: keeping superseded chunks would mean either retrieving stale
 * passages or carrying an is-current predicate through the one query whose
 * predicates are the isolation guarantee. `revision` counts the replacements
 * so a caller can see that something changed.
 *
 * The chunks and the outbox event are committed together. Embedding is a
 * provider call — slow, rate-limited, and able to fail — so it happens in the
 * worker, and the row that says it is owed is durable before anything is
 * published.
 */
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

    /**
     * The space is looked up, not created, until there is something to put in
     * it. The taxonomy is code-owned and every slug reaching here is a registry
     * member, so a missing row means only that this organization has not used
     * the space yet — and creating one for a submission that then fails
     * validation would leave a row nothing points at.
     */
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

    /**
     * Unchanged text is answered without a write and without an event.
     *
     * Re-ingestion is the ordinary way a source is kept current, so this is
     * the common case rather than an edge one — and re-embedding unchanged
     * text is a provider bill for an identical result.
     */
    if (existing !== null && existing.checksum === checksum) {
      /**
       * The text is what is content-addressed, not the reference to where it
       * came from. Correcting a mistyped `sourceUri` would otherwise be
       * impossible without perturbing the text — the submission is recognized
       * as unchanged and returns before the upsert. Written on its own: no
       * revision, no chunk rewrite, no embedding.
       */
      const sourceUri = input.sourceUri ?? null;

      /**
       * The response describes the row *after* this write, not before it.
       *
       * `updatedAt` carries `@updatedAt`, so correcting a `sourceUri` bumps it
       * — and returning the value read a moment earlier would answer the one
       * request that changed the row with the timestamp of the change before
       * it. A client that stores what it is told and uses it to decide whether
       * its copy is current would then believe its stale copy is the newest,
       * which is exactly the question this field exists to answer.
       * `updateManyAndReturn` keeps the scoped-write shape — a document
       * belonging to another organization still matches nothing — while
       * reporting what was committed.
       */
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

    /**
     * The unique constraint is the arbiter for a concurrent first ingestion.
     *
     * Whether this upsert compiles to `INSERT ... ON CONFLICT` or to a
     * find-then-create is Prisma's decision, not one this code states. Under
     * the second form two simultaneous submissions of a title that does not
     * yet exist race on the index and the loser raises P2002, which would
     * otherwise escape as a 500 for what is an ordinary conflict — and is
     * already answered as one when a *space* is created twice.
     */
    const document = await this.runIngestion(async (tx) => {
      /**
       * The space row is written here, inside the same commit as the document.
       *
       * Ensuring it beforehand would leave an empty space behind whenever the
       * ingestion that motivated it failed — a row in the taxonomy an operator
       * did not ask for, reported by the listing as configured with nothing in
       * it. The upsert is idempotent, so a concurrent first ingestion into the
       * same space is a lost race on the unique index rather than a duplicate.
       */
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

      /**
       * The old chunks go before the new ones arrive, in the same transaction.
       *
       * Retrieval reads whatever is committed, so a window in which both sets
       * exist is a window in which an agent is handed the document twice —
       * once as it is and once as it was.
       */
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

      /**
       * Keyed by document *and* revision. The dedupe key collapses the
       * duplicate deliveries a re-published outbox row produces, and including
       * the revision means a genuine second edit is a genuinely new job rather
       * than one BullMQ discards as a repeat of the first.
       */
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

  /**
   * One bounded page of a space's documents.
   *
   * Ordered by `(title, id)` and paged by that same pair, so the sequence is
   * deterministic and a document ingested mid-read cannot make the reader skip
   * or repeat a row. The page size is bounded server-side; the cursor names a
   * position and carries no authority, and the tenant and space predicates stay
   * in the query — so a cursor minted elsewhere positions over nothing but this
   * caller's own rows.
   *
   * A space this organization has never written to has no row and therefore no
   * documents. That is an empty page, not a 404: the slug is a registry member,
   * so it names a space that exists in the taxonomy whether or not anything is
   * stored in it yet.
   */
  async list(input: {
    organizationId: string;
    slug: KnowledgeSpaceSlug;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: DocumentListItem[]; nextCursor: string | null }> {
    const take = pageSize(input.limit);
    const after =
      input.cursor === undefined ? null : decodeCursor(input.cursor);

    const spaceId = await this.spaces.findId({
      organizationId: input.organizationId,
      slug: input.slug,
    });

    if (spaceId === null) return { items: [], nextCursor: null };

    /**
     * One row more than asked for, and it is not returned.
     *
     * Whether a next page exists is otherwise unknowable without a second
     * query or a count, and a `nextCursor` emitted whenever a page came back
     * full leaves a client fetching one empty page at the end of every
     * collection whose size divides evenly.
     */
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

  /**
   * Deliberately not gated on `knowledge.enabled`.
   *
   * The flag refuses *new* work — ingestion and the provider spend behind it.
   * Removal is the opposite: an operator who has just turned the feature off
   * for an organization is the likeliest person to want its material gone, and
   * a kill switch that locks the data in place would be the wrong shape. The
   * permission check still applies, so this is not open — it is simply not
   * something the flag is for.
   */
  async remove(input: {
    organizationId: string;
    documentId: string;
  }): Promise<{ id: string }> {
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

  /** Runs the ingestion transaction, translating a lost race into a conflict. */
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

  /**
   * Re-requests embedding for text that has not changed but is not embedded.
   *
   * Without this the content-addressed short-circuit is a dead end. Embedding
   * happens in the worker and can exhaust its attempts — the natural first-use
   * order is to enable the feature, store a document, and only then configure
   * the provider credential, which fails every attempt — and the only recovery
   * an operator will think to try is submitting the document again. That is
   * recognized as unchanged, so without this it writes no event, and nothing
   * else sweeps for chunks that are still owed a vector. The document stays
   * invisible to retrieval while the screen reports its passages.
   *
   * The same path is what makes a model change a matter of re-running: chunks
   * carrying a superseded model are owed a vector under the current one.
   *
   * Deliberately appended with no dedupe key. The key becomes BullMQ's job id,
   * and the failed job for this revision is retained for days, so a repair
   * carrying that key would be discarded as a duplicate of the delivery that
   * already failed. A repair is a new request, not a repeat of one. Asking
   * twice is cheap: the handler embeds only chunks still owed, so a repair
   * with nothing left to do writes nothing.
   */
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

/**
 * Everything strictly after a cursor position, in `(title, id)` order.
 *
 * Written as the disjunction rather than as a Prisma `cursor`/`skip` pair
 * because that pair is offset paging wearing a cursor's name — it locates the
 * row and then counts past it, which the row's own deletion breaks.
 */
function afterPosition(after: DocumentCursor) {
  return {
    OR: [
      { title: { gt: after.title } },
      { title: after.title, id: { gt: after.id } },
    ],
  };
}

/** SHA-256 of the text, so an unchanged submission is recognisable. */
function digestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
