import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  AgentRunService,
  CONTENT_IDEA_AGENT_ID,
  contentIdeaInput,
  contentIdeaOutput,
  type AgentRun,
  type ContentIdeaFormat,
  type ContentIdeaLanguage,
} from '../agents';
import { PrismaService } from '../database';
import { AppException } from '../core/errors';
import { Prisma } from '../generated/prisma/client';

/**
 * What a caller may ask to promote.
 *
 * Two fields, and deliberately neither of them prose. The caller names a run
 * they can already read and the position of the idea they picked out of it;
 * everything that ends up stored is then read off that run by this service. A
 * request shaped to carry the title and summary would be smaller code here and
 * a different feature: it would let a member persist text the agent never
 * produced while the row still pointed at a real run, and no later reader —
 * screen, export, or audit — could tell the difference.
 *
 * `ideaIndex` is bounded by the same ceiling the agent's own output schema
 * uses, so an obviously impossible index is refused before a database round
 * trip rather than after one.
 */
export const contentProjectFromIdeaInput = z
  .object({
    sourceRunId: z.string().trim().min(1).max(120),
    ideaIndex: z.number().int().min(0).max(9),
  })
  .strict();

export type ContentProjectFromIdeaInput = z.infer<
  typeof contentProjectFromIdeaInput
>;

/** The initial draft target. Revision 1, and nothing has written it. */
export type ContentDraftView = {
  id: string;
  revision: number;
  title: string;
  format: ContentIdeaFormat;
  language: ContentIdeaLanguage;
  body: string | null;
  createdAt: Date;
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
  drafts: ContentDraftView[];
};

export const CONTENT_PROJECT_PAGE_SIZE = 25;
export const MAX_CONTENT_PROJECT_PAGE_SIZE = 100;

/**
 * Content projects: the first thing this product lets an organization *decide*.
 *
 * Generating ideas was already possible and left no trace beyond the run. This
 * turns one of those ideas into a durable object with a draft attached, which
 * is what a writer — human or, later, an agent — can be pointed at.
 *
 * The service owns three things the database cannot: which runs are eligible to
 * select from, that the stored prose is the agent's rather than the caller's,
 * and that a retried request finds its own project. Tenant isolation is
 * deliberately *not* in that list. It is a foreign key on the pair
 * `(sourceRunId, organizationId)`, so a cross-organization selection is refused
 * by PostgreSQL whether or not the check below runs. The check exists to return
 * a clean 404 instead of a constraint violation, not to be the boundary.
 */
@Injectable()
export class ContentProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: AgentRunService,
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

    const selection = await this.resolveSelection({
      organizationId: input.organizationId,
      request: parsed.data,
    });

    const storedKey = projectKey(input.idempotencyKey, parsed.data);

    try {
      return await this.prisma.$transaction(async (tx) => {
        /**
         * The replay check, inside the transaction that would otherwise insert.
         *
         * Reading first is the common path and costs one indexed lookup. It is
         * not the guarantee — two concurrent retries can both miss here — which
         * is what the unique constraint and the catch below are for.
         */
        const existing = await tx.contentProject.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: storedKey,
            },
          },
          include: DRAFTS_INCLUDE,
        });

        if (existing) return toDetail(existing);

        const created = await tx.contentProject.create({
          data: {
            organizationId: input.organizationId,
            sourceRunId: selection.runId,
            sourceIdeaIndex: selection.index,
            title: selection.idea.title,
            hook: selection.idea.hook,
            angle: selection.idea.angle,
            summary: selection.idea.summary,
            suggestedFormat: selection.idea.suggestedFormat,
            language: selection.language,
            createdByUserId: input.actorUserId,
            idempotencyKey: storedKey,
            /**
             * Revision 1, in the same statement.
             *
             * A project without a draft is a state no caller should ever
             * observe: the draft is the thing the project exists to produce, so
             * a second write that could fail between them would make "has a
             * target" a property that sometimes takes effect later.
             */
            drafts: {
              create: {
                /**
                 * Connected rather than assigned, because `organizationId` is
                 * one scalar backing two relations here — the draft's own
                 * organization and its half of the composite key into the
                 * project. Prisma therefore takes it from a relation rather
                 * than from a field, and both resolve to the same value.
                 */
                organization: { connect: { id: input.organizationId } },
                revision: 1,
                title: selection.idea.title,
                format: selection.idea.suggestedFormat,
                language: selection.language,
                // No writer exists yet. A body seeded from the summary would be
                // words nobody wrote, and an unwritten draft would stop being
                // distinguishable from a written one.
                body: null,
                // Connected for the same reason, and because Prisma requires a
                // nested create to be consistently relation-shaped once any of
                // its foreign keys is expressed as one.
                createdByUser: { connect: { id: input.actorUserId } },
              },
            },
          },
          include: DRAFTS_INCLUDE,
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
        include: DRAFTS_INCLUDE,
      });

      /**
       * A P2002 on this insert can only be the durable idempotency constraint —
       * every other unique index on the two tables is either a generated id or
       * scoped to a project that did not exist a moment ago. Still fail loudly
       * if the winning row cannot be observed, rather than reporting a success
       * with nothing durable behind it.
       */
      if (!winner) throw error;

      return toDetail(winner);
    }
  }

  /**
   * Newest first, bounded, and paginated by a stable `(createdAt, id)` cursor.
   *
   * The cursor is a position rather than an offset, so a project created while
   * a reader is paging cannot shift the page under them into repeating or
   * skipping a row.
   */
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
      include: DRAFTS_INCLUDE,
    });

    // Also the answer for a project belonging to another organization: that it
    // exists elsewhere is not a distinction a caller is entitled to.
    if (project === null) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'contentProject' },
      });
    }

    return toDetail(project);
  }

  /**
   * Which idea is being promoted, read from the run rather than the request.
   *
   * The three refusals are not interchangeable. A run that is absent, owned by
   * another organization, or produced by another agent is reported as absent,
   * because none of those is a fact the caller is entitled to distinguish — the
   * same reasoning `ContentIdeaService.operation` already applies. A run the
   * caller *can* see but which has not succeeded is different: they can watch
   * it themselves, so pretending it does not exist would be a lie they can
   * check, and a conflict says the useful thing instead.
   */
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

    /**
     * The run succeeded, so the worker already parsed this against the same
     * schema before storing it. Unreachable in practice, and refused rather
     * than asserted: the day a future definition revision changes the output
     * shape, a run pinned to that revision must fail to be selected from
     * instead of being read through a schema it was never written against.
     */
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

    return {
      runId: run.id,
      index: input.request.ideaIndex,
      idea,
      language: contentLanguage(run),
    };
  }
}

const DRAFTS_INCLUDE = {
  drafts: { orderBy: { revision: 'asc' } },
} satisfies Prisma.ContentProjectInclude;

/**
 * The language the content is being planned in, taken from the request that
 * produced the idea.
 *
 * Not the selecting member's UI locale, which is the language they read menus
 * in and says nothing about what they are writing. Re-parsed rather than cast,
 * because `AgentRun.input` is a JSON column and the compiler cannot know a
 * pre-existing row still satisfies today's schema.
 *
 * A run whose input no longer parses falls back to the organization-wide
 * default rather than refusing. The language is a property of the draft target
 * and can be corrected; the idea itself is still perfectly selectable, and
 * throwing here would make a historical run permanently unusable over a field
 * that is not load-bearing.
 */
function contentLanguage(run: AgentRun): ContentIdeaLanguage {
  const input = contentIdeaInput.safeParse(run.input);

  return input.success ? input.data.language : 'ar';
}

/**
 * The caller's key plus a digest of what they asked for.
 *
 * The same composition `ContentIdeaService` uses, and for the same reason: the
 * durable constraint alone would hand an honest retry its own project and hand
 * a *reused* key somebody else's. Mixing the request into the key makes the two
 * different keys, so reuse gets the project it asked for rather than a
 * previous answer.
 */
function projectKey(
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
  include: typeof DRAFTS_INCLUDE;
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
    ...row,
    suggestedFormat: row.suggestedFormat as ContentIdeaFormat,
    language: row.language as ContentIdeaLanguage,
  };
}

function toDetail(row: ProjectRow): ContentProjectDetail {
  return {
    ...toView(row),
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

type ProjectCursor = { createdAt: Date; id: string };

function pageSize(requested: number | undefined): number {
  if (requested === undefined) return CONTENT_PROJECT_PAGE_SIZE;

  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_CONTENT_PROJECT_PAGE_SIZE
  ) {
    throw new AppException('VALIDATION_ERROR', {
      context: { resource: 'contentProject', reason: 'limit' },
      publicDetails: {
        reason: `A page holds between 1 and ${MAX_CONTENT_PROJECT_PAGE_SIZE} projects.`,
      },
    });
  }

  return requested;
}

function beforePosition(after: ProjectCursor) {
  return {
    OR: [
      { createdAt: { lt: after.createdAt } },
      { createdAt: after.createdAt, id: { lt: after.id } },
    ],
  };
}

function encodeCursor(cursor: ProjectCursor): string {
  return Buffer.from(
    JSON.stringify({ at: cursor.createdAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(value: string): ProjectCursor {
  const invalid = () =>
    new AppException('VALIDATION_ERROR', {
      context: { resource: 'contentProject', reason: 'cursor' },
      publicDetails: { reason: 'The page cursor is not readable.' },
    });

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }

  if (typeof parsed !== 'object' || parsed === null) throw invalid();

  const { at, id } = parsed as Record<string, unknown>;

  if (
    typeof at !== 'string' ||
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 120
  ) {
    throw invalid();
  }

  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime())) throw invalid();

  return { createdAt, id };
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
