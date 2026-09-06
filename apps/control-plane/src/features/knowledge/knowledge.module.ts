import { Module } from '@nestjs/common';

import { OrganizationAccessModule } from '../../infrastructure/auth/organization-access.module';
import { ControlPlaneCoreModule } from '../control-plane';
import { OutboxPersistenceModule } from '../../infrastructure/outbox';
import { DatabaseModule } from '../../infrastructure/database';
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
    EMBEDDING_PORT,
    KnowledgeRetrievalService,
    KnowledgeWriterService,
    KnowledgeSpaceService,
    KnowledgeIngestionService,
    KnowledgeEmbeddingHandler,
  ],
})
export class KnowledgeCoreModule {}

@Module({
  imports: [KnowledgeCoreModule, OrganizationAccessModule],
  controllers: [KnowledgeController],
  exports: [KnowledgeCoreModule],
})
export class KnowledgeModule {}
