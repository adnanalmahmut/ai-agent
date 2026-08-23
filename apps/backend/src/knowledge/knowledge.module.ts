import { Module } from '@nestjs/common';

import { ControlPlaneCoreModule } from '../control-plane';
import { DatabaseModule } from '../database';
import { PgVectorKnowledgeRepository } from './adapters/pgvector.repository';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { KnowledgeWriterService } from './knowledge-writer.service';
import { RETRIEVAL_PORT } from './ports/retrieval.port';

/**
 * The Knowledge core, in both composition roots.
 *
 * The worker needs it because an agent assembles its context at execution
 * time, not at acceptance time; the API needs it for the management surfaces
 * that follow. Neither gets a controller from here — this module is the
 * domain, and the HTTP surface will be declared beside the feature that serves
 * it, the way the control plane does.
 *
 * `EmbeddingPort` is deliberately unbound. Nothing in this PR turns text into
 * a vector: the ports state the contract, and the provider adapter arrives
 * with the ingestion pipeline that needs it. Binding a placeholder now would
 * be a fake in production code.
 */
@Module({
  imports: [DatabaseModule, ControlPlaneCoreModule],
  providers: [
    PgVectorKnowledgeRepository,
    { provide: RETRIEVAL_PORT, useExisting: PgVectorKnowledgeRepository },
    KnowledgeRetrievalService,
    KnowledgeWriterService,
  ],
  exports: [KnowledgeRetrievalService, KnowledgeWriterService],
})
export class KnowledgeCoreModule {}
