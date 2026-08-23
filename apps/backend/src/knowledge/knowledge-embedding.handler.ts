import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE_NAMES, type QueueJobHandler } from '../core/queue';
import { PrismaService } from '../database';
import { KnowledgeWriterService } from './knowledge-writer.service';
import type { KnowledgeDocumentIngestedJob } from './knowledge.events';
import { EMBEDDING_PORT, type EmbeddingPort } from './ports/embedding.port';

/**
 * Embedding a document's chunks, after the text is already durable.
 *
 * The work is here rather than in the request because it is a provider call:
 * slow, rate-limited, billed, and able to fail for reasons the person who
 * pasted the text cannot act on. Ingestion commits the chunks and an outbox
 * event; this finishes the job whenever the provider is willing.
 *
 * Idempotent by construction, which the queue requires: it embeds only the
 * chunks that currently lack a vector for the current model, so a redelivered
 * job after a partial success embeds the remainder and a redelivered job after
 * a complete one does nothing at all.
 */
@Injectable()
export class KnowledgeEmbeddingHandler implements QueueJobHandler<KnowledgeDocumentIngestedJob> {
  readonly queue = QUEUE_NAMES.knowledgeEmbedding;
  readonly jobName = 'embed';

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: KnowledgeWriterService,
    @Inject(EMBEDDING_PORT) private readonly embeddings: EmbeddingPort,
    private readonly logger: PinoLogger,
  ) {}

  async handle(job: Job<KnowledgeDocumentIngestedJob>): Promise<void> {
    const { documentId, organizationId } = job.data ?? {};

    if (typeof documentId !== 'string' || documentId.length === 0) {
      throw new Error('Knowledge embedding job requires a documentId');
    }

    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new Error('Knowledge embedding job requires an organizationId');
    }

    /**
     * Scoped to the organization from the payload as well as the document id.
     * The payload is written by this application and the id is a uuid, so this
     * is not defending against a forged job — it is keeping the tenant
     * predicate present on every path that touches a chunk, so no future
     * caller has to remember to add it.
     */
    /**
     * A page at a time, written before the next is requested.
     *
     * Reading the whole document and embedding it in one call made the job
     * all-or-nothing: a provider failure on the last batch of a long document
     * threw away every vector the earlier batches had already been billed for,
     * and the retry bought them again. Paging makes progress durable, so a
     * redelivery resumes where the failure happened — which is what the
     * idempotence above was always supposed to mean. It also caps resident
     * memory at one batch of vectors rather than one document's worth, on each
     * of the worker's concurrent slots.
     *
     * The cursor is the ordinal rather than the pending predicate. Paging on
     * "still unembedded" relies on each write clearing the row it just read,
     * which is true today and is not a property worth depending on for loop
     * termination.
     */
    let after = -1;
    let requested = 0;
    let written = 0;

    for (;;) {
      const pending = await this.prisma.knowledgeChunk.findMany({
        where: {
          documentId,
          organizationId,
          ordinal: { gt: after },
          OR: [
            { embeddingModel: null },
            { embeddingModel: { not: this.embeddings.model } },
          ],
        },
        orderBy: { ordinal: 'asc' },
        take: this.embeddings.maxBatch,
        select: { id: true, content: true, ordinal: true },
      });

      if (pending.length === 0) break;

      after = pending[pending.length - 1].ordinal;
      requested += pending.length;

      const vectors = await this.embeddings.embed(
        pending.map((chunk) => chunk.content),
      );

      if (vectors.length !== pending.length) {
        throw new Error(
          'The embedding provider returned the wrong number of vectors',
        );
      }

      for (const [index, chunk] of pending.entries()) {
        const vector = vectors[index];
        if (vector === undefined) continue;

        /**
         * One statement per chunk rather than one for the page. Each is a
         * different vector, so there is no batch form of this write — and a
         * chunk deleted by a re-ingestion that overtook this job simply
         * matches nothing, which is the correct outcome rather than an error.
         */
        const stored = await this.writer.setEmbedding({
          chunkId: chunk.id,
          organizationId,
          embedding: vector,
          model: this.embeddings.model,
        });

        if (stored) written += 1;
      }
    }

    if (requested === 0) return;

    this.logger.debug(
      { documentId, requested, written },
      'Knowledge document embedded',
    );
  }
}
