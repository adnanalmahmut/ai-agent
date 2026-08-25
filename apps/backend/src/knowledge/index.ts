/**
 * Public surface of the Knowledge domain.
 *
 * The pgvector repository and the OpenAI adapter are absent on purpose. Both
 * are bound to ports inside the module, and a feature importing either
 * directly would be depending on the storage engine or the provider rather
 * than on the question — which is the one thing the ports exist to prevent.
 */
export { KnowledgeCoreModule, KnowledgeModule } from './knowledge.module';
export { KnowledgeRetrievalService } from './knowledge-retrieval.service';
export { KnowledgeWriterService } from './knowledge-writer.service';
export { KnowledgeSpaceService } from './knowledge-space.service';
export type { KnowledgeSpaceSummary } from './knowledge-space.service';
export { KnowledgeIngestionService } from './knowledge-ingestion.service';
export type { IngestedDocument } from './knowledge-ingestion.service';
export { KnowledgeAuthorization } from './knowledge-authorization';
export {
  KnowledgePermissionGuard,
  RequiresKnowledge,
} from './knowledge-permission.guard';
export { KnowledgeEmbeddingHandler } from './knowledge-embedding.handler';

export {
  EMBEDDING_DIMENSIONS,
  type EmbeddingVector,
  type KnowledgeMatch,
  type RetrievalQuery,
} from './knowledge.types';

export { chunkDocument, MAX_CHUNK_CHARACTERS } from './chunking';
export {
  KNOWLEDGE_DOCUMENT_INGESTED,
  type KnowledgeDocumentIngestedJob,
} from './knowledge.events';

export { EMBEDDING_PORT, type EmbeddingPort } from './ports/embedding.port';
export { RETRIEVAL_PORT, type RetrievalPort } from './ports/retrieval.port';
