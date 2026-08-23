/**
 * Public surface of the Knowledge domain.
 *
 * The pgvector repository is absent on purpose. It is bound to `RETRIEVAL_PORT`
 * inside the module, and a feature that imported it directly would be depending
 * on the storage engine rather than on the question — which is the one thing
 * the port exists to prevent.
 */
export { KnowledgeCoreModule } from './knowledge.module';
export { KnowledgeRetrievalService } from './knowledge-retrieval.service';
export { KnowledgeWriterService } from './knowledge-writer.service';

export {
  EMBEDDING_DIMENSIONS,
  type EmbeddingVector,
  type KnowledgeMatch,
  type RetrievalQuery,
} from './knowledge.types';

export { EMBEDDING_PORT, type EmbeddingPort } from './ports/embedding.port';
export { RETRIEVAL_PORT, type RetrievalPort } from './ports/retrieval.port';
