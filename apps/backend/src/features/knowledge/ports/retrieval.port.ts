import type { KnowledgeMatch, RetrievalQuery } from '../knowledge.types';

export interface RetrievalPort {
  search(query: RetrievalQuery): Promise<KnowledgeMatch[]>;
}

export const RETRIEVAL_PORT = Symbol('RETRIEVAL_PORT');
