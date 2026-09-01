import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { Client } from 'pg';

import { CONTENT_IDEA_AGENT_ID } from '../../src/agents';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../support/auth-harness';

/**
 * Content projects, against the real application.
 *
 * No provider is reached and nothing is queued: promoting an idea reads a run
 * that already succeeded and writes two rows. What is only true end to end is
 * everything around that write — that the snapshot comes from the run rather
 * than the request, that the guard answers for the organization in the path,
 * that a retry finds its own project, and above all that PostgreSQL itself
 * refuses a selection that crosses a tenant boundary.
 *
 * The runs are seeded directly rather than generated. Executing one needs a
 * worker and a provider; what this file is about starts after that.
 */

type Draft = {
  id: string;
  revision: number;
  title: string;
  format: string;
  language: string;
  body: string | null;
};

type Project = {
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
  createdAt: string;
  drafts?: Draft[];
};

const dataOf = <T>(body: unknown): T => (body as { data: T }).data;

const IDEAS = [
  {
    title: 'Kettle teardown',
    hook: 'What is actually inside a £20 kettle?',
    angle: 'Cost breakdown as a trust signal',
    summary: 'Open one up on camera and cost each part.',
    suggestedFormat: 'video',
  },
  {
    title: 'Descaling in ninety seconds',
    hook: 'Your kettle is slower than it was.',
    angle: 'Maintenance as a retention hook',
    summary: 'A short carousel on descaling cadence.',
    suggestedFormat: 'carousel',
  },
  {
    title: 'Morning ritual',
    hook: 'The first thing you touch each day.',
    angle: 'Emotional framing over specification',
    summary: 'A post about routine rather than wattage.',
    suggestedFormat: 'post',
  },
] as const;

const RUN_INPUT = {
  topic: 'Electric kettles',
  goal: 'Sell the autumn range before December',
  language: 'en',
  numberOfIdeas: 3,
};

describe('content projects', () => {
  let harness: Harness;
  let owner: TestUser;
  let orgAdmin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let organizationId: string;
  let otherOrganizationId: string;
  let succeededRunId: string;
  let otherOrganizationRunId: string;
  let queuedRunId: string;

  const base = (id = organizationId) =>
    `/organizations/${encodeURIComponent(id)}/content-projects`;

  const createOrganization = async (user: TestUser, name: string) => {
    const response = await as(harness, user).post(
      '/api/auth/organization/create',
      { name, slug: `${name}-${Date.now().toString(36)}` },
    );

    expect(response.status).toBe(200);

    return (response.body as { id: string }).id;
  };

  const addMember = async (
    invitee: TestUser,
    role: string,
    target: string,
    inviter: TestUser,
  ) => {
    const invite = await as(harness, inviter).post(
      '/api/auth/organization/invite-member',
      { email: invitee.email, role, organizationId: target },
    );
    expect(invite.status).toBe(200);

    const accept = await as(harness, invitee).post(
      '/api/auth/organization/accept-invitation',
      { invitationId: (invite.body as { id: string }).id },
    );
    expect(accept.status).toBe(200);
  };

  const seedRun = async (options: {
    organizationId: string;
    status: 'QUEUED' | 'SUCCEEDED';
    agentId?: string;
  }) => {
    const run = await harness.prisma.agentRun.create({
      data: {
        agentId: options.agentId ?? CONTENT_IDEA_AGENT_ID,
        agentVersion: 1,
        runtime: 'mastra',
        status: options.status,
        organizationId: options.organizationId,
        input: RUN_INPUT,
        output:
          options.status === 'SUCCEEDED'
            ? { ideas: IDEAS, sources: [] }
            : undefined,
        idempotencyKey: `seed-${Math.random().toString(36).slice(2)}`,
        completedAt: options.status === 'SUCCEEDED' ? new Date() : null,
      },
      select: { id: true },
    });

    return run.id;
  };

  let keySeed = 0;
  const freshKey = () => `e2e-cp-${(keySeed += 1)}-${Date.now().toString(36)}`;

  const promote = (
    user: TestUser,
    body: unknown,
    key = freshKey(),
    organization = organizationId,
  ) =>
    as(harness, user)
      .post(`${base(organization)}/from-idea`, body)
      .set('idempotency-key', key);

  beforeAll(async () => {
    harness = await createHarness();

    owner = await createUser(harness);
    orgAdmin = await createUser(harness);
    member = await createUser(harness);
    outsider = await createUser(harness);

    organizationId = await createOrganization(owner, 'projects-acme');
    otherOrganizationId = await createOrganization(outsider, 'projects-other');

    await addMember(orgAdmin, 'admin', organizationId, owner);
    await addMember(member, 'member', organizationId, owner);

    succeededRunId = await seedRun({ organizationId, status: 'SUCCEEDED' });
    queuedRunId = await seedRun({ organizationId, status: 'QUEUED' });
    otherOrganizationRunId = await seedRun({
      organizationId: otherOrganizationId,
      status: 'SUCCEEDED',
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  describe('promoting an idea', () => {
    it("stores the agent's idea and opens revision 1 in one write", async () => {
      const response = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 1,
      });

      expect(response.status).toBe(201);

      const project = dataOf<Project>(response.body);

      // The snapshot is the agent's, read off the run at the chosen index.
      expect(project.title).toBe(IDEAS[1].title);
      expect(project.hook).toBe(IDEAS[1].hook);
      expect(project.angle).toBe(IDEAS[1].angle);
      expect(project.summary).toBe(IDEAS[1].summary);
      expect(project.suggestedFormat).toBe(IDEAS[1].suggestedFormat);
      expect(project.sourceIdeaIndex).toBe(1);
      expect(project.sourceRunId).toBe(succeededRunId);

      // The content language comes from the run's request, not a UI locale.
      expect(project.language).toBe('en');

      expect(project.drafts).toHaveLength(1);
      const draft = project.drafts?.[0];
      expect(draft?.revision).toBe(1);
      expect(draft?.title).toBe(IDEAS[1].title);
      expect(draft?.format).toBe(IDEAS[1].suggestedFormat);
      expect(draft?.language).toBe('en');
      // Nothing has written it. A seeded body would be words nobody chose.
      expect(draft?.body).toBeNull();
    });

    /**
     * The request carries an index, never prose.
     *
     * A body that also supplied a title is not a partially-honoured request:
     * the schema is strict, so it is refused outright. That is the point —
     * there is no shape of request that persists caller-authored text under an
     * agent-authored provenance.
     */
    it('refuses a request that tries to supply its own idea text', async () => {
      const response = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 0,
        title: 'Something the agent never said',
      });

      expect(response.status).toBe(400);
      expect(errorBody(response).errorCode).toBe('VALIDATION_ERROR');
    });

    it('refuses an index the run did not produce', async () => {
      const response = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 7,
      });

      expect(response.status).toBe(400);
      expect(errorBody(response).errorCode).toBe('VALIDATION_ERROR');
    });

    it('refuses a run that has not succeeded', async () => {
      const response = await promote(owner, {
        sourceRunId: queuedRunId,
        ideaIndex: 0,
      });

      expect(response.status).toBe(409);
      expect(errorBody(response).errorCode).toBe('CONFLICT');
    });

    it('requires an idempotency key', async () => {
      const response = await as(harness, owner).post(`${base()}/from-idea`, {
        sourceRunId: succeededRunId,
        ideaIndex: 0,
      });

      expect(response.status).toBe(400);
      expect(errorBody(response).errorCode).toBe('VALIDATION_ERROR');
    });
  });

  describe('idempotency', () => {
    it('returns the same project for a repeated key and body', async () => {
      const key = freshKey();
      const body = { sourceRunId: succeededRunId, ideaIndex: 2 };

      const first = await promote(owner, body, key);
      const second = await promote(owner, body, key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(dataOf<Project>(second.body).id).toBe(
        dataOf<Project>(first.body).id,
      );
    });

    /**
     * The stored key binds the caller's key to the request it arrived with, so
     * reuse gets the project it asked for rather than a previous answer.
     */
    it('treats the same key with a different body as a different request', async () => {
      const key = freshKey();

      const first = await promote(
        owner,
        {
          sourceRunId: succeededRunId,
          ideaIndex: 0,
        },
        key,
      );
      const second = await promote(
        owner,
        {
          sourceRunId: succeededRunId,
          ideaIndex: 1,
        },
        key,
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const firstProject = dataOf<Project>(first.body);
      const secondProject = dataOf<Project>(second.body);

      expect(secondProject.id).not.toBe(firstProject.id);
      expect(secondProject.sourceIdeaIndex).toBe(1);
    });
  });

  describe('concurrent and scoped idempotency', () => {
    /**
     * The path the sequential tests never take.
     *
     * Both existing replay tests await the first request, so they only ever hit
     * the in-transaction `findUnique`. The P2002 catch — the only thing that
     * makes two simultaneous retries safe — runs for the first time here. A
     * deterministic key derived from the run and index is exactly what the UI
     * sends, so a double-click is the ordinary shape of this, not an exotic one.
     */
    it('accepts two simultaneous identical requests as one project', async () => {
      const key = freshKey();
      const body = { sourceRunId: succeededRunId, ideaIndex: 2 };

      const [first, second] = await Promise.all([
        promote(owner, body, key),
        promote(owner, body, key),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(dataOf<Project>(second.body).id).toBe(
        dataOf<Project>(first.body).id,
      );

      // The status codes alone would be satisfied by two rows.
      const count = await harness.prisma.contentProject.count({
        where: { organizationId, idempotencyKey: { endsWith: key.slice(-8) } },
      });

      expect(count).toBeLessThanOrEqual(1);
    });

    /**
     * The key is scoped to the organization, not the platform.
     *
     * Two tenants using the same literal key is ordinary — clients pick their
     * own — and must produce two projects rather than one tenant reading the
     * other's answer.
     */
    it('keeps the same literal key in two organizations apart', async () => {
      const key = 'shared-literal-key-000001';

      const mine = await promote(
        owner,
        { sourceRunId: succeededRunId, ideaIndex: 0 },
        key,
      );
      const theirs = await promote(
        outsider,
        { sourceRunId: otherOrganizationRunId, ideaIndex: 0 },
        key,
        otherOrganizationId,
      );

      expect(mine.status).toBe(201);
      expect(theirs.status).toBe(201);
      expect(dataOf<Project>(theirs.body).id).not.toBe(
        dataOf<Project>(mine.body).id,
      );
    });

    /**
     * The key is not scoped to the member.
     *
     * Two admins clicking the same card get the same project. That is the
     * intended behaviour — the decision belongs to the organization — and it is
     * pinned here so that scoping the key to a user later is a deliberate,
     * test-visible change rather than a silent one.
     */
    it('is shared between two members of one organization', async () => {
      const key = freshKey();
      const body = { sourceRunId: succeededRunId, ideaIndex: 1 };

      const byOwner = await promote(owner, body, key);
      const byAdmin = await promote(orgAdmin, body, key);

      expect(dataOf<Project>(byAdmin.body).id).toBe(
        dataOf<Project>(byOwner.body).id,
      );
    });

    /**
     * Acceptance criterion 2, asserted as an invariant rather than on one path.
     *
     * Every assertion elsewhere is satisfied by two sequential writes; this one
     * is not. A project with no draft would mean the pair stopped being atomic.
     */
    it('leaves no project without its draft', async () => {
      const orphans = await harness.prisma.contentProject.count({
        where: { organizationId, drafts: { none: {} } },
      });

      expect(orphans).toBe(0);
    });
  });

  describe('tenant isolation', () => {
    it("reports another organization's run as absent", async () => {
      const response = await promote(owner, {
        sourceRunId: otherOrganizationRunId,
        ideaIndex: 0,
      });

      expect(response.status).toBe(404);
    });

    /**
     * 404, not 403, and pinned exactly.
     *
     * `OrganizationAccess` answers absent rather than forbidden for a
     * non-member precisely so a 403 cannot confirm an organization exists to
     * whoever guessed its id. Accepting either status would let that property
     * regress silently.
     */
    it('reports the organization as absent to a non-member', async () => {
      const response = await promote(
        outsider,
        { sourceRunId: succeededRunId, ideaIndex: 0 },
        freshKey(),
        organizationId,
      );

      expect(response.status).toBe(404);
      expect(errorBody(response).errorCode).not.toBe('FORBIDDEN');
    });

    /**
     * The guard runs before the body pipe.
     *
     * A non-member sending nonsense must be told the organization is absent,
     * not that their body failed validation — a 400 would confirm both that the
     * organization exists and what the request schema is.
     */
    it('refuses a non-member before it validates their body', async () => {
      const response = await promote(
        outsider,
        { nonsense: true },
        freshKey(),
        organizationId,
      );

      expect(response.status).toBe(404);
    });

    it("does not list another organization's projects", async () => {
      const created = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 0,
      });
      expect(created.status).toBe(201);
      const projectId = dataOf<Project>(created.body).id;

      const response = await as(harness, outsider).get(
        `${base(otherOrganizationId)}`,
      );

      expect(response.status).toBe(200);
      const listed = dataOf<{ items: Project[] }>(response.body).items;
      expect(listed.map((item) => item.id)).not.toContain(projectId);
    });

    it("reports another organization's project as absent on detail", async () => {
      const created = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 2,
      });
      const projectId = dataOf<Project>(created.body).id;

      const response = await as(harness, outsider).get(
        `${base(otherOrganizationId)}/${projectId}`,
      );

      expect(response.status).toBe(404);
    });

    /**
     * The boundary itself, asserted below the application.
     *
     * Every case above goes through the service, which checks the run belongs
     * to the caller's organization before it writes. This one bypasses all of
     * it and asks PostgreSQL directly, because that check is not what makes a
     * cross-tenant project impossible — the composite foreign key on
     * `(sourceRunId, organizationId)` is. A future refactor that drops the
     * service check would still be safe; one that drops the constraint would
     * not, and only this test would notice.
     */
    it('is refused by PostgreSQL even when the application is bypassed', async () => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();

      try {
        await expect(
          client.query(
            `INSERT INTO "content_project"
               ("id","organizationId","sourceRunId","sourceIdeaIndex",
                "title","hook","angle","summary","suggestedFormat","language",
                "idempotencyKey","createdAt","updatedAt")
             VALUES ($1,$2,$3,0,'t','h','a','s','post','en',$4,NOW(),NOW())`,
            [
              `cross-tenant-${Date.now()}`,
              // The other organization, pointing at this one's run.
              otherOrganizationId,
              succeededRunId,
              `cross-tenant-${Date.now()}`,
            ],
          ),
        ).rejects.toMatchObject({ code: '23503' });
      } finally {
        await client.end();
      }
    });
  });

  describe('eligible runs', () => {
    /**
     * A run from another agent is reported absent, not as a conflict.
     *
     * The distinction matters: a 409 would confirm the run exists in this
     * organization and merely produced the wrong shape, turning the endpoint
     * into an oracle for which agents an organization has been running.
     */
    it('reports a run from another agent as absent', async () => {
      const foreignAgentRun = await seedRun({
        organizationId,
        status: 'SUCCEEDED',
        agentId: 'some-other-agent',
      });

      const response = await promote(owner, {
        sourceRunId: foreignAgentRun,
        ideaIndex: 0,
      });

      expect(response.status).toBe(404);
      expect(errorBody(response).errorCode).toBe('NOT_FOUND');
    });

    /**
     * Distinct from the not-yet-succeeded conflict, and asserted as distinct.
     *
     * Both answer 409; without checking the reason either case could absorb the
     * other's regression.
     */
    it('refuses a succeeded run whose output this version cannot read', async () => {
      const unreadable = await harness.prisma.agentRun.create({
        data: {
          agentId: CONTENT_IDEA_AGENT_ID,
          agentVersion: 1,
          runtime: 'mastra',
          status: 'SUCCEEDED',
          organizationId,
          input: RUN_INPUT,
          // Violates contentIdeaOutput's `.min(1)`.
          output: { ideas: [], sources: [] },
          idempotencyKey: `seed-unreadable-${Date.now()}`,
          completedAt: new Date(),
        },
        select: { id: true },
      });

      const response = await promote(owner, {
        sourceRunId: unreadable.id,
        ideaIndex: 0,
      });

      expect(response.status).toBe(409);
      expect(errorBody(response).errorCode).toBe('CONFLICT');
      expect(JSON.stringify(response.body)).toContain('cannot read');
    });

    /**
     * A run whose stored input no longer parses is still selectable, and the
     * content language falls back to the product default on both rows.
     */
    it('falls back to the product default when the run input no longer parses', async () => {
      const legacy = await harness.prisma.agentRun.create({
        data: {
          agentId: CONTENT_IDEA_AGENT_ID,
          agentVersion: 1,
          runtime: 'mastra',
          status: 'SUCCEEDED',
          organizationId,
          // No `language`, no `goal`: an input shape this version cannot parse.
          input: { topic: 'Kettles' },
          output: { ideas: IDEAS, sources: [] },
          idempotencyKey: `seed-legacy-${Date.now()}`,
          completedAt: new Date(),
        },
        select: { id: true },
      });

      const response = await promote(owner, {
        sourceRunId: legacy.id,
        ideaIndex: 0,
      });

      expect(response.status).toBe(201);

      const project = dataOf<Project>(response.body);

      expect(project.language).toBe('ar');
      // The draft takes the language independently, so it is asserted
      // independently.
      expect(project.drafts?.[0]?.language).toBe('ar');
    });
  });

  describe('what the response carries', () => {
    /**
     * The whole field set, not a sample.
     *
     * `idempotencyKey` is a stored column holding the caller's own header, and
     * a per-field assertion cannot notice it arriving. Pinning the key set is
     * what makes an accidentally widened projection a test failure.
     */
    it('returns exactly the documented fields and no stored key', async () => {
      const response = await promote(
        owner,
        { sourceRunId: succeededRunId, ideaIndex: 0 },
        'wire-shape-probe-key-0001',
      );

      expect(response.status).toBe(201);

      const project = dataOf<Record<string, unknown>>(response.body);

      expect(Object.keys(project).sort()).toEqual([
        'angle',
        'createdAt',
        'createdByUserId',
        'drafts',
        'hook',
        'id',
        'language',
        'organizationId',
        'sourceIdeaIndex',
        'sourceRunId',
        'suggestedFormat',
        'summary',
        'title',
        'updatedAt',
      ]);

      expect(JSON.stringify(project)).not.toContain('wire-shape-probe-key');

      const listed = await as(harness, owner).get(base());
      expect(JSON.stringify(listed.body)).not.toContain('wire-shape-probe-key');
    });

    /** Who decided this is part of the record, and nullable columns rot quietly. */
    it('records the member who promoted the idea', async () => {
      const response = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 0,
      });

      expect(dataOf<Project>(response.body).createdByUserId).toBe(owner.id);

      const draft = await harness.prisma.contentDraft.findFirst({
        where: { projectId: dataOf<Project>(response.body).id },
        select: { createdByUserId: true },
      });

      expect(draft?.createdByUserId).toBe(owner.id);
    });
  });

  describe('authorization', () => {
    it('lets a plain member read but not promote', async () => {
      const read = await as(harness, member).get(base());
      expect(read.status).toBe(200);

      const write = await promote(member, {
        sourceRunId: succeededRunId,
        ideaIndex: 0,
      });
      expect(write.status).toBe(403);
    });

    it('lets an organization admin promote', async () => {
      const response = await promote(orgAdmin, {
        sourceRunId: succeededRunId,
        ideaIndex: 0,
      });

      expect(response.status).toBe(201);
    });
  });

  describe('reading', () => {
    it('lists newest first and pages on a stable cursor', async () => {
      const first = await as(harness, owner).get(`${base()}?limit=2`);

      expect(first.status).toBe(200);

      const page = dataOf<{ items: Project[]; nextCursor: string | null }>(
        first.body,
      );

      expect(page.items.length).toBeLessThanOrEqual(2);
      expect(page.nextCursor).not.toBeNull();

      const second = await as(harness, owner).get(
        `${base()}?limit=2&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
      );

      expect(second.status).toBe(200);

      const nextPage = dataOf<{ items: Project[] }>(second.body);
      const firstIds = page.items.map((item) => item.id);

      for (const item of nextPage.items) {
        expect(firstIds).not.toContain(item.id);
      }
    });

    /**
     * Paged to exhaustion, over rows that share a timestamp.
     *
     * Disjointness alone cannot see a *skipped* row, and the existing case
     * cannot produce a tie at all — HTTP-seeded projects land tens of
     * milliseconds apart. These are written directly with one identical
     * `createdAt`, which is the only arrangement that exercises the `id`
     * tiebreak. Drop it and every row but one vanishes from the results while a
     * disjointness assertion stays green.
     */
    it('drains every row when a whole page shares one timestamp', async () => {
      const sharedOrganizationId = await createOrganization(
        owner,
        'projects-tie',
      );
      const run = await seedRun({
        organizationId: sharedOrganizationId,
        status: 'SUCCEEDED',
      });
      const createdAt = new Date('2026-03-01T00:00:00.000Z');

      const expected: string[] = [];

      for (let index = 0; index < 5; index += 1) {
        const row = await harness.prisma.contentProject.create({
          data: {
            organizationId: sharedOrganizationId,
            sourceRunId: run,
            sourceIdeaIndex: 0,
            title: `Tied ${index}`,
            hook: 'h',
            angle: 'a',
            summary: 's',
            suggestedFormat: 'post',
            language: 'en',
            idempotencyKey: `tie-${index}`,
            createdAt,
            drafts: {
              create: {
                organization: { connect: { id: sharedOrganizationId } },
                revision: 1,
                title: `Tied ${index}`,
                format: 'post',
                language: 'en',
              },
            },
          },
          select: { id: true },
        });

        expected.push(row.id);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let guard = 0;

      do {
        const query: string =
          cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const page = await as(harness, owner).get(
          `${base(sharedOrganizationId)}?limit=2${query}`,
        );

        expect(page.status).toBe(200);

        const body = dataOf<{ items: Project[]; nextCursor: string | null }>(
          page.body,
        );

        seen.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
        guard += 1;
      } while (cursor !== null && guard < 10);

      // Terminates: the final page must say there is nothing after it.
      expect(cursor).toBeNull();
      // Complete and duplicate-free.
      expect(seen.slice().sort()).toEqual(expected.slice().sort());
      expect(new Set(seen).size).toBe(expected.length);
    });

    it('lists newest first', async () => {
      const response = await as(harness, owner).get(`${base()}?limit=10`);

      const items = dataOf<{ items: Project[] }>(response.body).items;
      const times = items.map((item) => new Date(item.createdAt).getTime());

      expect(times).toEqual(times.slice().sort((left, right) => right - left));
    });

    it('refuses an unreadable cursor', async () => {
      const response = await as(harness, owner).get(
        `${base()}?cursor=not-a-cursor`,
      );

      expect(response.status).toBe(400);
    });

    it('refuses a page size beyond the ceiling', async () => {
      const response = await as(harness, owner).get(`${base()}?limit=500`);

      expect(response.status).toBe(400);
    });

    it('returns the project with its drafts', async () => {
      const created = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 1,
      });
      const projectId = dataOf<Project>(created.body).id;

      const response = await as(harness, owner).get(`${base()}/${projectId}`);

      expect(response.status).toBe(200);

      const project = dataOf<Project>(response.body);
      expect(project.id).toBe(projectId);
      expect(project.drafts).toHaveLength(1);
      expect(project.drafts?.[0]?.revision).toBe(1);
    });
  });
});
