import type { operations } from '@repo/api-client/generated';
import { apiRequest } from '@/lib/application-api';

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
export const KNOWLEDGE_SPACE_SLUGS = [
  'organization.profile',
  'brand.identity',
  'brand.voice',
  'audience',
  'products.services',
  'content.strategy',
  'design.system',
  'faq',
] as const satisfies readonly KnowledgeSpaceSlug[];

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

export const CONTENT_IDEA_LANGUAGES = ['ar', 'en'] as const;

export type ContentIdeaLanguage = (typeof CONTENT_IDEA_LANGUAGES)[number];

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

export type ContentIdeaResult = {
  ideas: ContentIdea[];
  sources: string[];
};

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
  output: ContentIdeaResult | null;
  createdAt: string;
  completedAt: string | null;
};

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
