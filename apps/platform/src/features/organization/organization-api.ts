import type { operations } from '@repo/api-client/generated';
import { apiRequest } from '@/lib/application-api';
import { everyValueOf } from '@/lib/api/vocabulary';

import type {
  ArchivedOrganization,
  OrganizationBusinessProfile,
  OrganizationLifecycleResult,
  ReplaceOrganizationBusinessProfile,
} from './organization-types';

const ORGANIZATIONS = '/organizations';

export function archiveOrganization(
  organizationId: string,
  reason?: string,
): Promise<OrganizationLifecycleResult> {
  return apiRequest(
    `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/archive`,
    { method: 'POST', body: reason ? { reason } : {} },
  );
}

export function restoreOrganization(
  organizationId: string,
): Promise<OrganizationLifecycleResult> {
  return apiRequest(
    `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/restore`,
    { method: 'POST' },
  );
}

export function listArchivedOrganizations(
  signal?: AbortSignal,
): Promise<ArchivedOrganization[]> {
  return apiRequest(`${ORGANIZATIONS}/archived`, { signal });
}

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

/* ---------------------------------------------------------------------------
 * Knowledge
 *
 * The Backend's Zod schemas are the authored definition of these payloads.
 * They arrive here as generated OpenAPI types, so everything below is an alias
 * of that contract rather than a second description of it: change a schema,
 * run `pnpm api:types`, and the difference surfaces as a type error at
 * whichever caller it actually breaks.
 * ------------------------------------------------------------------------- */

/*
 * The `data` each operation answers with. The generated types describe the
 * whole success envelope the API sends; `apiRequest` already unwraps it, so
 * `data` is what these functions resolve to.
 */
type ListKnowledgeSpacesData =
  operations['listKnowledgeSpaces']['responses'][200]['content']['application/json']['data'];

type ClearKnowledgeSpaceData =
  operations['clearKnowledgeSpace']['responses'][200]['content']['application/json']['data'];

type ListKnowledgeDocumentsData =
  operations['listKnowledgeDocuments']['responses'][200]['content']['application/json']['data'];

type IngestKnowledgeDocumentData =
  operations['ingestKnowledgeDocument']['responses'][200]['content']['application/json']['data'];

type DeleteKnowledgeDocumentData =
  operations['deleteKnowledgeDocument']['responses'][200]['content']['application/json']['data'];

type IngestKnowledgeDocumentBody =
  operations['ingestKnowledgeDocument']['requestBody']['content']['application/json'];

/**
 * The documented query, plus the one option that is not part of the HTTP
 * contract: cancellation is a transport concern, so OpenAPI does not describe
 * an `AbortSignal` and neither does the generated type.
 */
type ListKnowledgeDocumentsOptions = NonNullable<
  operations['listKnowledgeDocuments']['parameters']['query']
> & { signal?: AbortSignal };

export type KnowledgeSpace = ListKnowledgeSpacesData[number];

export type KnowledgeSpaceSlug = KnowledgeSpace['slug'];

export type KnowledgeDocumentPage = ListKnowledgeDocumentsData;

export type KnowledgeDocument = KnowledgeDocumentPage['items'][number];

export type IngestedDocument = IngestKnowledgeDocumentData;

/**
 * The canonical slugs as runtime values, which the type alone cannot provide:
 * the message-catalogue test iterates them to prove every space is
 * translated. `satisfies` holds the list answerable to the generated union, so
 * a slug the API does not serve cannot be added here.
 */
export const KNOWLEDGE_SPACE_SLUGS = everyValueOf<KnowledgeSpaceSlug>()([
  'organization.profile',
  'brand.identity',
  'brand.voice',
  'audience',
  'products.services',
  'content.strategy',
  'design.system',
  'faq',
]);

const knowledgeBase = (organizationId: string) =>
  `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/knowledge`;

export function listKnowledgeSpaces(
  organizationId: string,
  signal?: AbortSignal,
): Promise<KnowledgeSpace[]> {
  return apiRequest(`${knowledgeBase(organizationId)}/spaces`, { signal });
}

export function clearKnowledgeSpace(
  organizationId: string,
  slug: KnowledgeSpaceSlug,
): Promise<ClearKnowledgeSpaceData> {
  return apiRequest(
    `${knowledgeBase(organizationId)}/spaces/${encodeURIComponent(slug)}`,
    { method: 'DELETE' },
  );
}

export function listKnowledgeDocuments(
  organizationId: string,
  slug: KnowledgeSpaceSlug,
  options: ListKnowledgeDocumentsOptions = {},
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

export function ingestKnowledgeDocument(
  organizationId: string,
  slug: KnowledgeSpaceSlug,
  document: IngestKnowledgeDocumentBody,
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
): Promise<DeleteKnowledgeDocumentData> {
  return apiRequest(
    `${knowledgeBase(organizationId)}/documents/${encodeURIComponent(
      documentId,
    )}`,
    { method: 'DELETE' },
  );
}

/* ---------------------------------------------------------------------------
 * Content ideas
 *
 * Same rule as Knowledge: the Backend's Zod contract is the authored
 * definition, and everything here is an alias of its generated form. A screen
 * that reads a field the API stopped sending fails to compile.
 * ------------------------------------------------------------------------- */

type ContentIdeaAvailabilityData =
  operations['getContentIdeaAvailability']['responses'][200]['content']['application/json']['data'];

/*
 * Acceptance answers 201 and the status read answers 200 with the same
 * operation, which is what lets one held value carry a request from
 * acceptance through to a terminal state.
 */
type RequestContentIdeasData =
  operations['requestContentIdeas']['responses'][201]['content']['application/json']['data'];

type GetContentIdeaOperationData =
  operations['getContentIdeaOperation']['responses'][200]['content']['application/json']['data'];

export type ContentIdeaRequest =
  operations['requestContentIdeas']['requestBody']['content']['application/json'];

/*
 * Both create endpoints require an idempotency key, and now say so. Taking the
 * header object from the operation means the name is the documented one rather
 * than a literal that can drift from it; HTTP header names are
 * case-insensitive, so what crosses the wire is unchanged.
 */
type RequestContentIdeasHeaders =
  operations['requestContentIdeas']['parameters']['header'];

export type ContentIdeaAvailability = ContentIdeaAvailabilityData;

export type ContentIdeaUnavailableReason = NonNullable<
  ContentIdeaAvailability['reason']
>;

export type ContentIdeaOperation = RequestContentIdeasData &
  GetContentIdeaOperationData;

export type ContentIdeaStatus = ContentIdeaOperation['status'];

export type ContentIdeaResult = NonNullable<ContentIdeaOperation['output']>;

export type ContentIdea = ContentIdeaResult['ideas'][number];

export type ContentIdeaLanguage = ContentIdeaRequest['language'];

export type ContentIdeaFormat = ContentIdea['suggestedFormat'];

/*
 * The closed vocabularies as runtime values, which the types alone cannot
 * provide: the form offers them and the message-catalogue test iterates them.
 * `everyValueOf` holds each list level with its generated union in both
 * directions — a value the API does not accept cannot be added, and a value it
 * starts accepting cannot be left out.
 */
export const CONTENT_IDEA_LANGUAGES = everyValueOf<ContentIdeaLanguage>()([
  'ar',
  'en',
]);

export const CONTENT_IDEA_FORMATS = everyValueOf<ContentIdeaFormat>()([
  'carousel',
  'post',
  'video',
]);

export const CONTENT_IDEA_STATUSES = everyValueOf<ContentIdeaStatus>()([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
]);

export const CONTENT_IDEA_UNAVAILABLE_REASONS =
  everyValueOf<ContentIdeaUnavailableReason>()([
    'agents_disabled',
    'content_ideas_disabled',
    'agent_not_installed',
    'agent_disabled',
  ]);

const contentIdeasBase = (organizationId: string) =>
  `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/content-ideas`;

export function getContentIdeaAvailability(
  organizationId: string,
  signal?: AbortSignal,
): Promise<ContentIdeaAvailability> {
  return apiRequest(`${contentIdeasBase(organizationId)}/availability`, {
    signal,
  });
}

export function requestContentIdeas(
  organizationId: string,
  request: ContentIdeaRequest,
  idempotencyKey: string,
): Promise<ContentIdeaOperation> {
  return apiRequest(contentIdeasBase(organizationId), {
    method: 'POST',
    body: request,
    headers: {
      'Idempotency-Key': idempotencyKey,
    } satisfies RequestContentIdeasHeaders,
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

type CreateContentProjectData =
  operations['createContentProjectFromIdea']['responses'][201]['content']['application/json']['data'];

type ListContentProjectsData =
  operations['listContentProjects']['responses'][200]['content']['application/json']['data'];

type GetContentProjectData =
  operations['getContentProject']['responses'][200]['content']['application/json']['data'];

export type CreateContentProjectFromIdeaBody =
  operations['createContentProjectFromIdea']['requestBody']['content']['application/json'];

type CreateContentProjectHeaders =
  operations['createContentProjectFromIdea']['parameters']['header'];

/** The documented query, plus cancellation, which HTTP does not describe. */
type ListContentProjectsOptions = NonNullable<
  operations['listContentProjects']['parameters']['query']
>;

export type ContentProjectDetail = CreateContentProjectData &
  GetContentProjectData;

export type ContentProjectPage = ListContentProjectsData;

export type ContentProject = ContentProjectPage['items'][number];

export type ContentProjectBrief = ContentProjectDetail['brief'];

export type ContentDraft = ContentProjectDetail['drafts'][number];

const contentProjectsBase = (organizationId: string) =>
  `${ORGANIZATIONS}/${encodeURIComponent(organizationId)}/content-projects`;

export function createContentProjectFromIdea(
  organizationId: string,
  selection: CreateContentProjectFromIdeaBody,
  idempotencyKey: string,
): Promise<ContentProjectDetail> {
  return apiRequest(`${contentProjectsBase(organizationId)}/from-idea`, {
    method: 'POST',
    body: selection,
    headers: {
      'Idempotency-Key': idempotencyKey,
    } satisfies CreateContentProjectHeaders,
  });
}

export function listContentProjects(
  organizationId: string,
  options: ListContentProjectsOptions = {},
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

export const AGENT_ACTION_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;

export type AgentActionApprovalStatus =
  (typeof AGENT_ACTION_APPROVAL_STATUSES)[number];

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
