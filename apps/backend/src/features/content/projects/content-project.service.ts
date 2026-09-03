import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { AgentRunService } from '../../../ai/execution/agent-run.service';
import {
  CONTENT_IDEA_AGENT_ID,
  contentIdeaInput,
  contentIdeaOutput,
  type ContentIdeaFormat,
  type ContentIdeaLanguage,
} from '../ideas/agent-definitions';
import { PrismaService } from '../../../infrastructure/database';
import { OrganizationAuditService } from '../../organizations/audit';
import {
  beforePosition,
  encodeCursor,
  decodeCursor,
  pageSize,
} from './content-project-pagination';
import { AppException } from '../../../core/errors';
import { Prisma } from '../../../generated/prisma/client';

export const contentProjectFromIdeaInput = z
  .object({
    sourceRunId: z.string().trim().min(1).max(120),
    ideaIndex: z.number().int().min(0).max(9),
  })
  .strict();

export type ContentProjectFromIdeaInput = z.infer<
  typeof contentProjectFromIdeaInput
>;

export type ContentDraftView = {
  id: string;
  revision: number;
  title: string;
  format: ContentIdeaFormat;
  language: ContentIdeaLanguage;
  body: string | null;
  createdAt: Date;
};

export type ContentProjectBrief = {
  topic: string;
  goal: string;
  audience: string | null;
  guidance: string | null;
};

export type ContentProjectView = {
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
  createdAt: Date;
  updatedAt: Date;
};

export type ContentProjectDetail = ContentProjectView & {
  brief: ContentProjectBrief;
  drafts: ContentDraftView[];
};

@Injectable()
export class ContentProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: AgentRunService,
    private readonly audit: OrganizationAuditService,
  ) {}

  async createFromIdea(input: {
    organizationId: string;
    actorUserId: string;
    idempotencyKey: string;
    payload: unknown;
  }): Promise<ContentProjectDetail> {
    const parsed = contentProjectFromIdeaInput.safeParse(input.payload);

    if (!parsed.success) {
      throw new AppException('VALIDATION_ERROR', {
        context: { resource: 'contentProject' },
        publicDetails: {
          issues: parsed.error.issues.map((issue) => issue.message),
        },
      });
    }

    const storedKey = projectKey(input.idempotencyKey, parsed.data);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.contentProject.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: storedKey,
            },
          },
          select: PROJECT_DETAIL_SELECT,
        });

        if (existing) return toDetail(existing);

        const selection = await this.resolveSelection({
          organizationId: input.organizationId,
          request: parsed.data,
        });

        const created = await tx.contentProject.create({
          data: {
            organizationId: input.organizationId,
            sourceRunId: selection.runId,
            sourceIdeaIndex: selection.index,
            topic: selection.brief.topic,
            goal: selection.brief.goal,
            audience: selection.brief.audience ?? null,
            guidance: selection.brief.guidance ?? null,
            title: selection.idea.title,
            hook: selection.idea.hook,
            angle: selection.idea.angle,
            summary: selection.idea.summary,
            suggestedFormat: selection.idea.suggestedFormat,
            language: selection.language,
            createdByUserId: input.actorUserId,
            idempotencyKey: storedKey,
            drafts: {
              create: {
                organization: { connect: { id: input.organizationId } },
                revision: 1,
                title: selection.idea.title,
                format: selection.idea.suggestedFormat,
                language: selection.language,
                // Null distinguishes a draft target from authored content.
                body: null,
                createdByUser: { connect: { id: input.actorUserId } },
              },
            },
          },
          select: PROJECT_DETAIL_SELECT,
        });

        await this.audit.recordContentProjectCreation(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          projectId: created.id,
          sourceRunId: created.sourceRunId,
          sourceIdeaIndex: created.sourceIdeaIndex,
          // Preserve the parsed closed vocabulary in the audit projection.
          suggestedFormat: selection.idea.suggestedFormat,
          language: selection.language,
          draftRevision: created.drafts[0].revision,
        });

        return toDetail(created);
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      const winner = await this.prisma.contentProject.findUnique({
        where: {
          organizationId_idempotencyKey: {
            organizationId: input.organizationId,
            idempotencyKey: storedKey,
          },
        },
        select: PROJECT_DETAIL_SELECT,
      });

      if (!winner) throw error;

      return toDetail(winner);
    }
  }

  async list(input: {
    organizationId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: ContentProjectView[]; nextCursor: string | null }> {
    const take = pageSize(input.limit);
    const after =
      input.cursor === undefined ? null : decodeCursor(input.cursor);

    const rows = await this.prisma.contentProject.findMany({
      where: {
        organizationId: input.organizationId,
        ...(after === null ? {} : beforePosition(after)),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      select: PROJECT_SELECT,
    });

    const items = rows.slice(0, take).map(toView);
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        rows.length > take && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async detail(input: {
    organizationId: string;
    projectId: string;
  }): Promise<ContentProjectDetail> {
    const project = await this.prisma.contentProject.findFirst({
      where: { id: input.projectId, organizationId: input.organizationId },
      select: PROJECT_DETAIL_SELECT,
    });

    // Cross-tenant and missing resources remain indistinguishable.
    if (project === null) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'contentProject' },
      });
    }

    return toDetail(project);
  }

  private async resolveSelection(input: {
    organizationId: string;
    request: ContentProjectFromIdeaInput;
  }) {
    const run = await this.runs.findForOrganization({
      organizationId: input.organizationId,
      runId: input.request.sourceRunId,
    });

    if (run === null || run.agentId !== CONTENT_IDEA_AGENT_ID) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'contentIdeaOperation' },
      });
    }

    if (run.status !== 'SUCCEEDED') {
      throw new AppException('CONFLICT', {
        context: { resource: 'contentProject', reason: 'source_run_status' },
        publicDetails: {
          reason: 'Ideas can only be selected from a request that succeeded.',
        },
      });
    }

    const output = contentIdeaOutput.safeParse(run.output);

    if (!output.success) {
      throw new AppException('CONFLICT', {
        context: { resource: 'contentProject', reason: 'source_run_output' },
        publicDetails: {
          reason: 'That request produced ideas this version cannot read.',
        },
      });
    }

    const idea = output.data.ideas[input.request.ideaIndex];

    if (idea === undefined) {
      throw new AppException('VALIDATION_ERROR', {
        context: { resource: 'contentProject', reason: 'idea_index' },
        publicDetails: {
          reason: 'That request did not produce an idea at that position.',
        },
      });
    }

    const brief = contentIdeaInput.safeParse(run.input);

    if (!brief.success) {
      throw new AppException('CONFLICT', {
        context: { resource: 'contentProject', reason: 'source_run_input' },
        publicDetails: {
          reason: 'That request was made in a form this version cannot read.',
        },
      });
    }

    return {
      runId: run.id,
      index: input.request.ideaIndex,
      idea,
      brief: brief.data,
      language: brief.data.language,
    };
  }
}

const PROJECT_SELECT = {
  id: true,
  organizationId: true,
  sourceRunId: true,
  sourceIdeaIndex: true,
  title: true,
  hook: true,
  angle: true,
  summary: true,
  suggestedFormat: true,
  language: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ContentProjectSelect;

const PROJECT_DETAIL_SELECT = {
  ...PROJECT_SELECT,
  topic: true,
  goal: true,
  audience: true,
  guidance: true,
  drafts: {
    orderBy: { revision: 'asc' },
    select: {
      id: true,
      revision: true,
      title: true,
      format: true,
      language: true,
      body: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ContentProjectSelect;

export function projectKey(
  callerKey: string,
  request: ContentProjectFromIdeaInput,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([request.sourceRunId, request.ideaIndex]), 'utf8')
    .digest('hex')
    .slice(0, 32);

  return `content-project:${callerKey}:${digest}`;
}

type ProjectRow = Prisma.ContentProjectGetPayload<{
  select: typeof PROJECT_DETAIL_SELECT;
}>;

function toView(row: {
  id: string;
  organizationId: string;
  sourceRunId: string;
  sourceIdeaIndex: number;
  title: string;
  hook: string;
  angle: string;
  summary: string;
  suggestedFormat: string;
  language: string;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ContentProjectView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    sourceRunId: row.sourceRunId,
    sourceIdeaIndex: row.sourceIdeaIndex,
    title: row.title,
    hook: row.hook,
    angle: row.angle,
    summary: row.summary,
    suggestedFormat: row.suggestedFormat as ContentIdeaFormat,
    language: row.language as ContentIdeaLanguage,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDetail(row: ProjectRow): ContentProjectDetail {
  return {
    ...toView(row),
    brief: {
      topic: row.topic,
      goal: row.goal,
      audience: row.audience,
      guidance: row.guidance,
    },
    drafts: row.drafts.map((draft) => ({
      id: draft.id,
      revision: draft.revision,
      title: draft.title,
      format: draft.format as ContentIdeaFormat,
      language: draft.language as ContentIdeaLanguage,
      body: draft.body,
      createdAt: draft.createdAt,
    })),
  };
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
