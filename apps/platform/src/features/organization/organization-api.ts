import { apiRequest } from '@/lib/application-api';

import type {
  ArchivedOrganization,
  OrganizationBusinessProfile,
  OrganizationLifecycleResult,
  ReplaceOrganizationBusinessProfile,
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

/* ------------------------- business settings -------------------------- */

const businessProfilePath = (organizationId: string) =>
  `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/business-profile`;

export function getOrganizationBusinessProfile(
  organizationId: string,
  signal?: AbortSignal,
): Promise<OrganizationBusinessProfile> {
  return apiRequest(businessProfilePath(organizationId), { signal });
}

export function replaceOrganizationBusinessProfile(
  organizationId: string,
  profile: ReplaceOrganizationBusinessProfile,
): Promise<OrganizationBusinessProfile> {
  return apiRequest(businessProfilePath(organizationId), {
    method: 'PUT',
    body: profile,
  });
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

/**
 * The canonical taxonomy, mirrored from the backend registry.
 *
 * A mirror rather than an import: the two applications do not share a module,
 * and the alternative — deriving the list from whatever the server returned —
 * would make the message test unable to say anything, since a missing
 * translation would only surface for an organization whose server happened to
 * return that space. Held here, the test asserts copy for all eight and a
 * ninth added to the backend fails the build the moment it is mirrored.
 *
 * The dots are load-bearing twice over: they are the slug the server addresses
 * a space by, and — because `use-intl` reserves `.` as its path separator —
 * they are also the nesting of the message that names it.
 */
export const KNOWLEDGE_SPACE_SLUGS = [
  'organization.profile',
  'brand.identity',
  'brand.voice',
  'audience',
  'products.services',
  'content.strategy',
  'design.system',
  'faq',
] as const;

export type KnowledgeSpaceSlug = (typeof KNOWLEDGE_SPACE_SLUGS)[number];

/**
 * A knowledge space, as the application defines it.
 *
 * There is no `id` and no create call, and both absences are the design. The
 * taxonomy is code-owned on the backend: the same eight spaces exist for every
 * organization, addressed by slug, and a row appears only when something is
 * ingested into one. A customer cannot invent a space, so the client has
 * nothing to name and no identifier to carry.
 *
 * `name` and `description` come back from the server for completeness, but the
 * screen renders a translated name keyed on the slug instead — an operator
 * reading Arabic should not be shown an English taxonomy.
 */
export type KnowledgeSpace = {
  slug: string;
  name: string;
  description: string;
  /** False until this organization has stored something in it. */
  configured: boolean;
  documentCount: number;
  createdAt: string | null;
  updatedAt: string | null;
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

/**
 * One page of documents.
 *
 * `nextCursor` is null on the last page and is the only way to ask for the
 * next one — the client never computes an offset, because an offset is wrong
 * the moment a document is ingested while somebody is paging.
 */
export type KnowledgeDocumentPage = {
  items: KnowledgeDocument[];
  nextCursor: string | null;
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

/**
 * Empties a space: its documents and their chunks go with it.
 *
 * The space itself does not disappear — it is a registry entry and still
 * appears in the listing, now with nothing in it.
 */
export function clearKnowledgeSpace(
  organizationId: string,
  slug: string,
): Promise<{ slug: string }> {
  return apiRequest(
    `${knowledgeBase(organizationId)}/spaces/${encodeURIComponent(slug)}`,
    { method: 'DELETE' },
  );
}

export function listKnowledgeDocuments(
  organizationId: string,
  slug: string,
  options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<KnowledgeDocumentPage> {
  const query = new URLSearchParams();

  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));

  const suffix = query.size === 0 ? '' : `?${query.toString()}`;

  return apiRequest(
    `${knowledgeBase(organizationId)}/spaces/${encodeURIComponent(
      slug,
    )}/documents${suffix}`,
    { signal: options.signal },
  );
}

/** `PUT`, because a document is addressed by title and re-submitting is a replace. */
export function ingestKnowledgeDocument(
  organizationId: string,
  slug: string,
  document: { title: string; sourceUri?: string; content: string },
): Promise<IngestedDocument> {
  return apiRequest(
    `${knowledgeBase(organizationId)}/spaces/${encodeURIComponent(
      slug,
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

/**
 * What a caller asks for.
 *
 * `language` is the language of the *content* being planned, and is chosen per
 * request rather than read from the reader's UI locale. An Arabic-speaking
 * marketer writing English campaign copy is the ordinary case, and inferring
 * the content language from the language somebody reads menus in would make
 * that case unreachable.
 */
export const CONTENT_IDEA_LANGUAGES = ['ar', 'en'] as const;

export type ContentIdeaLanguage = (typeof CONTENT_IDEA_LANGUAGES)[number];

/**
 * The formats an idea may be proposed in, mirroring the backend enum exactly.
 *
 * A value rather than only a union, so the message test can assert this screen
 * has a word for each one. A format arriving with no copy would render its own
 * key path where a badge should be.
 */
export const CONTENT_IDEA_FORMATS = ['carousel', 'post', 'video'] as const;

export type ContentIdeaFormat = (typeof CONTENT_IDEA_FORMATS)[number];

export type ContentIdeaRequest = {
  topic: string;
  goal: string;
  language: ContentIdeaLanguage;
  audience?: string;
  guidance?: string;
  numberOfIdeas: number;
};

export type ContentIdea = {
  title: string;
  hook: string;
  angle: string;
  summary: string;
  suggestedFormat: ContentIdeaFormat;
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

/**
 * Why generation is or is not available to this organization right now.
 *
 * A product answer rather than a control-plane one: an ordinary member holds no
 * platform permission, and the screen needs to know whether the button will
 * work — not how the platform is configured.
 */
export const CONTENT_IDEA_UNAVAILABLE_REASONS = [
  'agents_disabled',
  'content_ideas_disabled',
  'agent_not_installed',
  'agent_disabled',
] as const;

export type ContentIdeaUnavailableReason =
  (typeof CONTENT_IDEA_UNAVAILABLE_REASONS)[number];

export type ContentIdeaAvailability = {
  available: boolean;
  reason: ContentIdeaUnavailableReason | null;
};

const contentIdeasBase = (organizationId: string) =>
  `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/content-ideas`;

/**
 * Advisory, and the screen treats it that way.
 *
 * A flag can be switched off between this read and the submission that follows
 * it, so acceptance stays authoritative. This exists so the common case does
 * not require filling in a form and pressing a button to discover the feature
 * is off.
 */
export function getContentIdeaAvailability(
  organizationId: string,
  signal?: AbortSignal,
): Promise<ContentIdeaAvailability> {
  return apiRequest(`${contentIdeasBase(organizationId)}/availability`, {
    signal,
  });
}

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

/* ---------------------------------------------------------------------------
 * Content projects
 *
 * One selected idea, promoted into work the organization has committed to.
 * ------------------------------------------------------------------------- */

export type ContentDraft = {
  id: string;
  revision: number;
  title: string;
  format: ContentIdeaFormat;
  language: ContentIdeaLanguage;
  /** Null until something writes it. No writer exists yet. */
  body: string | null;
  createdAt: string;
};

export type ContentProject = {
  id: string;
  organizationId: string;
  sourceRunId: string;
  sourceIdeaIndex: number;
  title: string;
  hook: string;
  angle: string;
  summary: string;
  suggestedFormat: ContentIdeaFormat;
  language: ContentIdeaLanguage;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The brief the ideas were generated from, snapshotted onto the project.
 *
 * Detail only — the list does not carry it, because a backlog screen shows what
 * was decided rather than the paragraph behind each decision.
 */
export type ContentProjectBrief = {
  topic: string;
  goal: string;
  audience: string | null;
  guidance: string | null;
};

export type ContentProjectDetail = ContentProject & {
  brief: ContentProjectBrief;
  drafts: ContentDraft[];
};

export type ContentProjectPage = {
  items: ContentProject[];
  nextCursor: string | null;
};

const contentProjectsBase = (organizationId: string) =>
  `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/content-projects`;

/**
 * The request names a run and a position, never the idea's text.
 *
 * The server reads the prose off the run it was pointed at, so a screen cannot
 * — even by accident — persist something the agent did not say.
 *
 * The key is a parameter for the same reason it is on `requestContentIdeas`:
 * only the caller holding the button knows whether a second click is a retry of
 * the first or a fresh decision.
 */
export function createContentProjectFromIdea(
  organizationId: string,
  selection: { sourceRunId: string; ideaIndex: number },
  idempotencyKey: string,
): Promise<ContentProjectDetail> {
  return apiRequest(`${contentProjectsBase(organizationId)}/from-idea`, {
    method: 'POST',
    body: selection,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function listContentProjects(
  organizationId: string,
  options: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ContentProjectPage> {
  const query = new URLSearchParams();
  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));

  const suffix = query.size === 0 ? '' : `?${query.toString()}`;

  return apiRequest(`${contentProjectsBase(organizationId)}${suffix}`, {
    signal,
  });
}

export function getContentProject(
  organizationId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ContentProjectDetail> {
  return apiRequest(
    `${contentProjectsBase(organizationId)}/${encodeURIComponent(projectId)}`,
    { signal },
  );
}

/* ------------------------- agent action approvals ---------------------- */

/**
 * The decision states a proposal can be in, mirrored from the backend.
 *
 * Mirrored rather than imported for the same reason the knowledge slugs are:
 * the two applications share no module, and holding the list here is what
 * lets the message test assert copy for every state rather than for whichever
 * ones a server happened to return.
 */
export const AGENT_ACTION_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;

export type AgentActionApprovalStatus =
  (typeof AGENT_ACTION_APPROVAL_STATUSES)[number];

/**
 * The execution's own lifecycle, which is where the effect lives.
 *
 * `STARTED` is a read-only execution and never appears on an approval, but
 * the vocabulary is the backend's whole enum so a value arriving here always
 * has copy.
 */
export const TOOL_EXECUTION_STATUSES = [
  'STARTED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'SUCCEEDED',
  'FAILED',
  'OUTCOME_UNKNOWN',
] as const;

export type ToolExecutionStatus = (typeof TOOL_EXECUTION_STATUSES)[number];

/**
 * The closed failure vocabulary the backend writes to an execution, mirrored
 * so a code with no copy renders a generic "not sent" rather than its own key
 * path.
 */
export const TOOL_FAILURE_CODES = [
  'precondition_organization',
  'precondition_authority',
  'precondition_approval',
  'precondition_recipient',
  'delivery_unsupported',
  'provider_rejected',
  'implementation_error',
  'output_rejected',
] as const;

export type ToolFailureCode = (typeof TOOL_FAILURE_CODES)[number];

/**
 * The proposal, as the server projects it for a reader.
 *
 * One `kind` for now. The recipient is resolved server-side at read time and
 * is `null` when the member the agent named is no longer one — the reader is
 * deciding whether to send to a person, and the person may be gone.
 */
export type AgentActionProposal = {
  kind: 'notification.send@1';
  recipient: { memberId: string; name: string; email: string } | null;
  subject: string;
  body: string;
};

export type AgentActionApproval = {
  toolExecutionId: string;
  organizationId: string;
  agentRunId: string;
  agentId: string;
  agentVersion: number;
  toolId: string;
  toolVersion: number;
  executionStatus: ToolExecutionStatus;
  approval: {
    status: AgentActionApprovalStatus;
    requestedAt: string;
    decidedAt: string | null;
    decidedByUserId: string | null;
    decisionNote: string | null;
  };
  proposal: AgentActionProposal | null;
  effect: {
    attemptCount: number;
    firstAttemptedAt: string | null;
    completedAt: string | null;
    failureCode: string | null;
  };
};

export type AgentActionApprovalPage = {
  items: AgentActionApproval[];
  nextCursor: string | null;
};

const approvalsBase = (organizationId: string) =>
  `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/agent-action-approvals`;

export function listAgentActionApprovals(
  organizationId: string,
  options: {
    status?: AgentActionApprovalStatus;
    cursor?: string;
    limit?: number;
  } = {},
  signal?: AbortSignal,
): Promise<AgentActionApprovalPage> {
  const query = new URLSearchParams();
  if (options.status !== undefined) query.set('status', options.status);
  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));

  const suffix = query.size === 0 ? '' : `?${query.toString()}`;

  return apiRequest(`${approvalsBase(organizationId)}${suffix}`, { signal });
}

export function getAgentActionApproval(
  organizationId: string,
  toolExecutionId: string,
  signal?: AbortSignal,
): Promise<AgentActionApproval> {
  return apiRequest(
    `${approvalsBase(organizationId)}/${encodeURIComponent(toolExecutionId)}`,
    { signal },
  );
}

/**
 * The two decisions. Each is one request, answered with the decided view, and
 * refused with 409 when somebody else decided first — which the block shows
 * as exactly that rather than as a failure of the reader's own click.
 */
export function approveAgentAction(
  organizationId: string,
  toolExecutionId: string,
  note?: string,
): Promise<AgentActionApproval> {
  return apiRequest(
    `${approvalsBase(organizationId)}/${encodeURIComponent(toolExecutionId)}/approve`,
    { method: 'POST', body: note ? { note } : {} },
  );
}

export function rejectAgentAction(
  organizationId: string,
  toolExecutionId: string,
  note?: string,
): Promise<AgentActionApproval> {
  return apiRequest(
    `${approvalsBase(organizationId)}/${encodeURIComponent(toolExecutionId)}/reject`,
    { method: 'POST', body: note ? { note } : {} },
  );
}
