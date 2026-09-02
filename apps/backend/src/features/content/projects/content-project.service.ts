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

/**
 * The brief the ideas were generated from.
 *
 * Read off the run by the server, never sent by the caller — the same rule the
 * idea snapshot follows, and for a stronger reason: this is the part a writer
 * works to, so text a member could substitute here would redirect the work
 * while still looking agent-derived.
 */
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

/**
 * Detail carries the brief; the list does not.
 *
 * A backlog screen shows what was decided, not the paragraph behind each
 * decision, and putting four more text columns on every row of every page
 * would make the list heavier for something nothing on it renders.
 */
export type ContentProjectDetail = ContentProjectView & {
  brief: ContentProjectBrief;
  drafts: ContentDraftView[];
};

/**
 * Content projects: the first thing this product lets an organization *decide*.
 *
 * Generating ideas was already possible and left no trace beyond the run. This
 * turns one of those ideas into a durable object with a draft attached, which
 * is what a writer — human or, later, an agent — can be pointed at.
 *
 * The service owns three things the database cannot: which runs are eligible to
 * select from, that the stored prose is the agent's rather than the caller's,
 * and that a retried request finds its own project.
 *
 * For *selection* specifically, tenant isolation is deliberately not among
 * them: it is a foreign key on the pair `(sourceRunId, organizationId)`, so a
 * cross-organization selection is refused by PostgreSQL whether or not the
 * check below runs, and the check exists to return a clean 404 rather than a
 * constraint violation. That is a claim about selection only. On the read
 * paths the `organizationId` predicate is the whole boundary, with no
 * constraint standing behind it.
 */
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
          select: PROJECT_DETAIL_SELECT,
        });

        if (existing) return toDetail(existing);

        /**
         * Resolved after the replay check, not before it.
         *
         * A project that already exists must be returnable without consulting
         * the run again. Resolving first would make an honest retry depend on
         * the run still being *selectable* — and the one scenario
         * `resolveSelection` exists to refuse, a definition revision whose
         * output this version cannot read, would then turn every retry of an
         * already-succeeded promotion into a conflict. The snapshot is copied
         * precisely so the project outlives that; reading the run before
         * checking for the project would give the copy away.
         */
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
          select: PROJECT_DETAIL_SELECT,
        });

        /**
         * Appended on the transaction client, so it is one write with the
         * project and its draft.
         *
         * A replay never reaches here — it returned above — which is what keeps
         * one decision to one event no matter how many times a client retries.
         * And because the append shares the transaction, an audit failure rolls
         * the project back rather than leaving a decision nothing recorded:
         * for a log later readers are meant to trust, a silent gap is worse
         * than a refusal the caller can see.
         */
        await this.audit.recordContentProjectCreation(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          projectId: created.id,
          sourceRunId: created.sourceRunId,
          sourceIdeaIndex: created.sourceIdeaIndex,
          // Taken from the parsed selection rather than read back off the
          // row: these are `String` columns, and the audit projection types
          // them as the code-owned enums so that its closedness is a compiler
          // guarantee rather than a provenance argument.
          suggestedFormat: selection.idea.suggestedFormat,
          language: selection.language,
          /**
           * The revision this promotion opened.
           *
           * Read rather than written as `1`, but deliberately not defaulted:
           * the nested create above produces exactly one draft, so an absent
           * row is not a case to paper over with a plausible number. A log that
           * invents `draftRevision: 1` for a project with no draft is the same
           * fabrication `before: DbNull` exists to avoid.
           *
           * Note this is the *lowest* revision, since the projection orders
           * them ascending. Same row here, and it stops being the same row once
           * revision 2 exists — at which point whatever creates that revision
           * records its own event and this call site is untouched.
           */
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

      /**
       * A P2002 on this insert can only be the durable idempotency constraint —
       * every other unique index across the three tables this transaction now
       * writes is either a generated id or scoped to a project that did not
       * exist a moment ago — the audit table has no unique constraint beyond
       * its own generated id. Still fail loudly
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

    /**
     * The brief, from the run's own input.
     *
     * Refusing when it does not parse is a deliberate change of mind. This used
     * to read only the content language out of the input and fall back to the
     * product default when the input was unreadable, on the grounds that the
     * language was not load-bearing and a historical run should stay
     * selectable. The brief *is* load-bearing: a project exists so that a
     * writer can work from it without reaching back into the run, and one
     * carrying no topic and no goal would push exactly that dependency back
     * onto every future consumer. A project that cannot state what it is for
     * is not worth creating, so this refuses instead of creating a hollow one.
     *
     * Both halves now come from one parse, which is also why the language no
     * longer has a fallback of its own: a run whose input this version cannot
     * read is refused before the question arises.
     */
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

/**
 * Enumerated rather than spread.
 *
 * `idempotencyKey` is a stored column and is deliberately absent: it embeds the
 * caller's own `Idempotency-Key` header, which belongs to whoever sent it and
 * to nobody else in the organization. A `findMany` with no projection returns
 * every scalar, and `toView` spreads what it is handed — so with a structural
 * parameter type the compiler cannot see the difference between the row it
 * declares and the row it gets. Naming the columns here is what keeps the wire
 * shape equal to `ContentProjectView` instead of merely assignable to it, and
 * it is what the audit reader already does for the same reason.
 */
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

/**
 * The caller's key plus a digest of what they asked for.
 *
 * The same composition `ContentIdeaService` uses, and for the same reason: the
 * durable constraint alone would hand an honest retry its own project and hand
 * a *reused* key somebody else's. Mixing the request into the key makes the two
 * different keys, so reuse gets the project it asked for rather than a
 * previous answer.
 */
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

/**
 * Built field by field, not spread.
 *
 * A spread copies whatever the query returned, and its parameter type cannot
 * stop it — the compiler only sees the keys the signature declares, so a column
 * added to the projection travels to the wire silently. That is exactly how the
 * stored idempotency key escaped once, and how the brief's four columns escaped
 * again the moment the detail projection grew them. Naming the fields makes the
 * response shape a decision rather than a consequence.
 */
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
