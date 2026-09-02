/**
 * The outbox event type this domain publishes.
 *
 * A constant rather than a literal at both ends, because the producer and the
 * consumer are in different processes and a typo would not fail — it would
 * write rows the route table cannot deliver.
 */
export const KNOWLEDGE_DOCUMENT_INGESTED = 'knowledge-document.ingested';

export type KnowledgeDocumentIngestedJob = {
  documentId: string;
  organizationId: string;
};
