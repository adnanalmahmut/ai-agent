export type EmbeddingVector = readonly number[];

export const EMBEDDING_DIMENSIONS = 1536;

export type RetrievalQuery = {
  organizationId: string;
  embeddingModel: string;
  spaceIds: readonly string[];
  embedding: EmbeddingVector;
  limit: number;
};

export type KnowledgeMatch = {
  chunkId: string;
  documentId: string;
  spaceId: string;
  content: string;
  score: number;
};
