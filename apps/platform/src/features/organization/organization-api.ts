import { apiRequest } from '@/lib/application-api';

import type {
  ArchivedOrganization,
  OrganizationLifecycleResult,
} from './organization-types';

/**
 * The organization lifecycle, which belongs to this application rather than to
 * Better Auth.
 *
 * Archiving is not an authentication concept and Better Auth has no opinion
 * about it. It is a product decision — take an organization offline, keep
 * every row — that the backend implements on its own routes, so these three
 * calls go through the application API boundary rather than the auth client.
 *
 * Hard deletion is absent, and its absence is the design. The backend runs
 * with `disableOrganizationDeletion`, no role is granted `organization:delete`,
 * and there is no function here to call. Three independent locks on a door
 * this product does not have.
 */

const ORGANIZATIONS = '/organizations';

/** Takes an organization offline. Reversible; nothing is deleted. */
export function archiveOrganization(
  organizationId: string,
  reason?: string,
): Promise<OrganizationLifecycleResult> {
  return apiRequest(
    `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/archive`,
    { method: 'POST', body: reason ? { reason } : {} },
  );
}

/** Brings one back. */
export function restoreOrganization(
  organizationId: string,
): Promise<OrganizationLifecycleResult> {
  return apiRequest(
    `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/restore`,
    { method: 'POST' },
  );
}

/**
 * The archived organizations this caller can see.
 *
 * Needed because Better Auth's `/organization/list` deliberately hides them —
 * the backend filters archived organizations out of it so an archived
 * organization is invisible to every ordinary flow. That is correct, and it
 * leaves exactly one gap: without a separate read, an owner could archive an
 * organization and then have no way to find it again.
 *
 * The server decides who may restore each one and says so per row, so the UI
 * never has to work it out from a role.
 */
export function listArchivedOrganizations(
  signal?: AbortSignal,
): Promise<ArchivedOrganization[]> {
  return apiRequest(`${ORGANIZATIONS}/archived`, { signal });
}

/* ----------------------------- knowledge ------------------------------ */

/**
 * The organization's reference material.
 *
 * Addressed by the organization in the path rather than by whichever one the
 * session has selected, because the backend authorizes the same way — a
 * request naming a different organization than the reader's active one is
 * answered about the organization it names.
 */

export type KnowledgeSpace = {
  id: string;
  slug: string;
  name: string;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeDocument = {
  id: string;
  title: string;
  sourceUri: string | null;
  checksum: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  _count: { chunks: number };
};

/** What ingestion answers, including whether the text was new. */
export type IngestedDocument = {
  id: string;
  title: string;
  revision: number;
  chunkCount: number;
  changed: boolean;
};

const knowledgeBase = (organizationId: string) =>
  `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/knowledge`;

export function listKnowledgeSpaces(
  organizationId: string,
  signal?: AbortSignal,
): Promise<KnowledgeSpace[]> {
  return apiRequest(`${knowledgeBase(organizationId)}/spaces`, { signal });
}

export function createKnowledgeSpace(
  organizationId: string,
  space: { slug: string; name: string },
): Promise<KnowledgeSpace> {
  return apiRequest(`${knowledgeBase(organizationId)}/spaces`, {
    method: 'POST',
    body: space,
  });
}

export function deleteKnowledgeSpace(
  organizationId: string,
  spaceId: string,
): Promise<{ id: string }> {
  return apiRequest(
    `${knowledgeBase(organizationId)}/spaces/${encodeURIComponent(spaceId)}`,
    { method: 'DELETE' },
  );
}

export function listKnowledgeDocuments(
  organizationId: string,
  spaceId: string,
  signal?: AbortSignal,
): Promise<KnowledgeDocument[]> {
  return apiRequest(
    `${knowledgeBase(organizationId)}/spaces/${encodeURIComponent(
      spaceId,
    )}/documents`,
    { signal },
  );
}

/** `PUT`, because a document is addressed by title and re-submitting is a replace. */
export function ingestKnowledgeDocument(
  organizationId: string,
  spaceId: string,
  document: { title: string; sourceUri?: string; content: string },
): Promise<IngestedDocument> {
  return apiRequest(
    `${knowledgeBase(organizationId)}/spaces/${encodeURIComponent(
      spaceId,
    )}/documents`,
    { method: 'PUT', body: document },
  );
}

export function deleteKnowledgeDocument(
  organizationId: string,
  documentId: string,
): Promise<{ id: string }> {
  return apiRequest(
    `${knowledgeBase(organizationId)}/documents/${encodeURIComponent(
      documentId,
    )}`,
    { method: 'DELETE' },
  );
}

/* ---------------------------- content ideas ---------------------------- */

/**
 * Asking the content-idea agent for ideas, and reading the answer.
 *
 * Two calls and no third, mirroring the backend. Generation is asynchronous
 * because it is a provider call that takes seconds and can fail, so the
 * request returns an operation and the caller polls it — there is no
 * synchronous variant to reach for.
 */

export type ContentIdeaRequest = {
  topic: string;
  audience: string;
  guidance?: string;
  count: number;
};

export type ContentIdea = {
  title: string;
  angle: string;
  format: string;
};

/** What the agent returns, once it has returned. */
export type ContentIdeaResult = {
  ideas: ContentIdea[];
  sources: string[];
};

/**
 * The run lifecycle, mirroring the backend's `AgentRunStatus` exactly.
 *
 * A value rather than only a union, so the message test can assert this screen
 * has a word for each one. A status arriving with no copy renders its own key
 * path where a word should be.
 */
export const CONTENT_IDEA_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
] as const;

export type ContentIdeaStatus = (typeof CONTENT_IDEA_STATUSES)[number];

export type ContentIdeaOperation = {
  id: string;
  status: ContentIdeaStatus;
  /** Present only once the run succeeded; the backend withholds it until then. */
  output: ContentIdeaResult | null;
  createdAt: string;
  completedAt: string | null;
};

const contentIdeasBase = (organizationId: string) =>
  `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/content-ideas`;

/**
 * The key is a parameter, not something generated here.
 *
 * Whether two submissions are the same request is a decision only the caller
 * holding the form can make: a retry after a connection failure is the same
 * request and must reuse its key, while a second ask with an edited topic is a
 * different one. Minting a key inside this function would make every retry a
 * new purchase.
 */
export function requestContentIdeas(
  organizationId: string,
  request: ContentIdeaRequest,
  idempotencyKey: string,
): Promise<ContentIdeaOperation> {
  return apiRequest(contentIdeasBase(organizationId), {
    method: 'POST',
    body: request,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function getContentIdeaOperation(
  organizationId: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<ContentIdeaOperation> {
  return apiRequest(
    `${contentIdeasBase(organizationId)}/${encodeURIComponent(operationId)}`,
    { signal },
  );
}
