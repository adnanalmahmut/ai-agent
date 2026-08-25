import type { KnowledgeMatch, RetrievalQuery } from '../knowledge.types';

/**
 * Reading organization-scoped material, as a contract.
 *
 * One method, because retrieval is one question. The port exists so the
 * pgvector adapter stays replaceable and so the raw SQL that answers it has
 * exactly one home — not because a second implementation is planned.
 */
export interface RetrievalPort {
  /**
   * Returns the closest chunks the query is allowed to see, best first.
   *
   * Implementations must scope by `organizationId` **inside the query that
   * ranks**, never by filtering results afterwards. A post-filter ranks the
   * whole table first, which is both wrong and slow: another organization's
   * closer material displaces this one's from the top `limit` before the
   * filter ever runs.
   *
   * An empty `spaceIds` must return nothing. "No space was granted" is not a
   * broader query, and an implementation that dropped an empty list from its
   * predicate would read the whole organization. `KnowledgeRetrievalService`
   * short-circuits before calling this, so the rule holds regardless — this
   * states it so a second implementation does not have to infer it.
   */
  search(query: RetrievalQuery): Promise<KnowledgeMatch[]>;
}

export const RETRIEVAL_PORT = Symbol('RETRIEVAL_PORT');
