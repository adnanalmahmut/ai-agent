import { Module } from '@nestjs/common';

import { ControlPlaneCoreModule } from '../control-plane';
import { OutboxPersistenceModule } from '../core/outbox';
import { DatabaseModule } from '../database';
import { OpenAiEmbeddingAdapter } from './adapters/openai-embedding.adapter';
import { PgVectorKnowledgeRepository } from './adapters/pgvector.repository';
import { KnowledgeAuthorization } from './knowledge-authorization';
import { KnowledgePermissionGuard } from './knowledge-permission.guard';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeEmbeddingHandler } from './knowledge-embedding.handler';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { KnowledgeSpaceService } from './knowledge-space.service';
import { KnowledgeWriterService } from './knowledge-writer.service';
import { EMBEDDING_PORT } from './ports/embedding.port';
import { RETRIEVAL_PORT } from './ports/retrieval.port';

/**
 * The Knowledge core, in both execution modes.
 *
 * The worker needs it because embedding happens there and because an agent
 * assembles its context when the run executes, not from a snapshot taken when
 * it was accepted. The API needs it for the management surface.
 *
 * The split follows the control plane's precedent for the same reason: the
 * core carries no controller, so importing it into a process that serves no
 * HTTP cannot drag one in. `KnowledgeModule` adds the controller and is for
 * `AppModule` alone.
 *
 * `EmbeddingPort` is answered by the OpenAI adapter. It is the real one in
 * both roots — tests substitute a double through Nest's own override, rather
 * than the composition root binding a fake that could reach production.
 */
@Module({
  imports: [DatabaseModule, ControlPlaneCoreModule, OutboxPersistenceModule],
  providers: [
    PgVectorKnowledgeRepository,
    { provide: RETRIEVAL_PORT, useExisting: PgVectorKnowledgeRepository },
    OpenAiEmbeddingAdapter,
    { provide: EMBEDDING_PORT, useExisting: OpenAiEmbeddingAdapter },
    KnowledgeRetrievalService,
    KnowledgeWriterService,
    KnowledgeSpaceService,
    KnowledgeIngestionService,
    KnowledgeAuthorization,
    KnowledgePermissionGuard,
    KnowledgeEmbeddingHandler,
  ],
  exports: [
    KnowledgeRetrievalService,
    KnowledgeWriterService,
    KnowledgeSpaceService,
    KnowledgeIngestionService,
    KnowledgeAuthorization,
    KnowledgeEmbeddingHandler,
  ],
})
export class KnowledgeCoreModule {}

/** The core plus the organization-facing HTTP surface. For `AppModule` only. */
@Module({
  imports: [KnowledgeCoreModule],
  controllers: [KnowledgeController],
  exports: [KnowledgeCoreModule],
})
export class KnowledgeModule {}
