import { Module } from '@nestjs/common';

import { OrganizationAccessModule } from '../core/auth/organization-access.module';
import { ControlPlaneCoreModule } from '../control-plane';
import { OutboxPersistenceModule } from '../core/outbox';
import { DatabaseModule } from '../database';
import { OpenAiEmbeddingAdapter } from './adapters/openai-embedding.adapter';
import { PgVectorKnowledgeRepository } from './adapters/pgvector.repository';
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
    KnowledgeEmbeddingHandler,
  ],
  exports: [
    /**
     * The port, not the adapter. An agent's context assembler has to embed a
     * query with the same model the chunks were embedded with, and exporting
     * the symbol keeps that a contract rather than a second import of the
     * OpenAI adapter in a module that has no business naming a provider.
     */
    EMBEDDING_PORT,
    KnowledgeRetrievalService,
    KnowledgeWriterService,
    KnowledgeSpaceService,
    KnowledgeIngestionService,
    KnowledgeEmbeddingHandler,
  ],
})
export class KnowledgeCoreModule {}

/** The core plus the organization-facing HTTP surface. For `AppModule` only. */
@Module({
  imports: [KnowledgeCoreModule, OrganizationAccessModule],
  controllers: [KnowledgeController],
  exports: [KnowledgeCoreModule],
})
export class KnowledgeModule {}
