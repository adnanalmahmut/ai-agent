import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE_NAMES, type QueueJobHandler } from '../../infrastructure/queue';
import { PrismaService } from '../../infrastructure/database';
import { KnowledgeWriterService } from './knowledge-writer.service';
import type { KnowledgeDocumentIngestedJob } from './knowledge.events';
import { EMBEDDING_PORT, type EmbeddingPort } from './ports/embedding.port';

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
