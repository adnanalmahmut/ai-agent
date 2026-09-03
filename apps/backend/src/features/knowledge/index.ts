export { KnowledgeCoreModule, KnowledgeModule } from './knowledge.module';
export { KnowledgeRetrievalService } from './knowledge-retrieval.service';
export { KnowledgeWriterService } from './knowledge-writer.service';
export { KnowledgeSpaceService } from './knowledge-space.service';
export type { KnowledgeSpaceSummary } from './knowledge-space.service';
export {
  KNOWLEDGE_SPACES,
  KNOWLEDGE_SPACE_SLUGS,
  isKnowledgeSpaceSlug,
  knowledgeSpaceDefinition,
  type KnowledgeSpaceDefinition,
  type KnowledgeSpaceSlug,
} from './knowledge-space.registry';
export {
  DOCUMENT_PAGE_SIZE,
  MAX_DOCUMENT_PAGE_SIZE,
} from './knowledge-pagination';
export { KnowledgeIngestionService } from './knowledge-ingestion.service';
export type {
  DocumentListItem,
  IngestedDocument,
} from './knowledge-ingestion.service';
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
