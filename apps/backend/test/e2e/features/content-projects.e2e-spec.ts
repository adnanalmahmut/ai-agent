import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { Client } from 'pg';

import { CONTENT_IDEA_AGENT_ID } from '../../../src/features/content/ideas/agent-definitions';
import { OrganizationAuditService } from '../../../src/features/organizations/audit';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

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
  audience: 'Home cooks',
  guidance: 'Keep it warm and practical, never technical.',
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

  /** Every organization this suite creates, so cleanup can find them all. */
  const ownedOrganizationIds: string[] = [];

  const createOrganization = async (user: TestUser, name: string) => {
    const response = await as(harness, user).post(
      '/api/auth/organization/create',
      { name, slug: `${name}-${Date.now().toString(36)}` },
    );

    expect(response.status).toBe(200);

    const id = (response.body as { id: string }).id;
    ownedOrganizationIds.push(id);

    return id;
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

  /**
   * Everything this suite wrote, removed.
   *
   * Not politeness. `AgentRunReconciler.reconcileOnce()` sweeps *every*
   * non-terminal run in the database, not the ones belonging to some
   * organization, so the queued run seeded here counts toward another suite's
   * `missing` tally and fails it — which is exactly what happened in CI once
   * this file grew enough to be scheduled before that one. Runs are shared
   * state, and a suite that seeds a non-terminal one has to take it away
   * again. `content-ideas.e2e-spec.ts` clears its runs for the same reason.
   *
   * Ordered by the foreign keys: drafts cascade from projects, and projects
   * restrict on the runs they were promoted from, so projects go before runs.
   */
  afterAll(async () => {
    if (harness !== undefined && ownedOrganizationIds.length > 0) {
      const scope = { organizationId: { in: ownedOrganizationIds } };

      await harness.prisma.contentProject.deleteMany({ where: scope });

      /**
       * The audit events stay. `organization_audit_event` is append-only at the
       * database — a DELETE raises `55000` — which is the whole point of that
       * table, and they harm nothing: every assertion here scopes to an
       * organization this suite created fresh, so accumulated history from a
       * previous run cannot be counted by this one.
       */

      const runs = await harness.prisma.agentRun.findMany({
        where: scope,
        select: { id: true },
      });

      if (runs.length > 0) {
        await harness.prisma.outboxEvent.deleteMany({
          where: { dedupeKey: { in: runs.map((run) => run.id) } },
        });
      }

      await harness.prisma.agentRun.deleteMany({ where: scope });
    }

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
      expect(JSON.stringify(response.body)).toContain(
        'only be selected from a request that succeeded',
      );
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
     * A replay is answered before the run is consulted, and that ordering is
     * now load-bearing.
     *
     * Hoisting `resolveSelection` above the replay lookup would turn every
     * retry against a run this version can no longer parse into a 409, leaving
     * the client unable to re-fetch a project it already owns through the
     * idempotent POST. The refusal added by the brief snapshot made that a
     * much more reachable mistake than it was, so it is pinned here.
     */
    it('replays a project whose source run has since become unreadable', async () => {
      const run = await seedRun({ organizationId, status: 'SUCCEEDED' });
      const key = freshKey();
      const body = { sourceRunId: run, ideaIndex: 0 };

      const first = await promote(owner, body, key);
      expect(first.status).toBe(201);

      // The run's input stops being readable after the fact.
      await harness.prisma.agentRun.update({
        where: { id: run },
        data: { input: { nothing: 'this version understands' } },
      });

      // A fresh promotion is now refused...
      expect((await promote(owner, body, freshKey())).status).toBe(409);

      // ...but the retry still finds the project it already created.
      const replay = await promote(owner, body, key);

      expect(replay.status).toBe(201);
      expect(dataOf<Project>(replay.body).id).toBe(
        dataOf<Project>(first.body).id,
      );
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
            // The brief columns are supplied so this reaches the foreign key
            // rather than tripping a NOT NULL check on the way to it.
            `INSERT INTO "content_project"
               ("id","organizationId","sourceRunId","sourceIdeaIndex",
                "topic","goal",
                "title","hook","angle","summary","suggestedFormat","language",
                "idempotencyKey","createdAt","updatedAt")
             VALUES ($1,$2,$3,0,'topic','goal','t','h','a','s','post','en',$4,NOW(),NOW())`,
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
      // Discriminated: three refusals now answer 409, and without this each
      // could absorb another's regression.
      expect(JSON.stringify(response.body)).toContain('produced ideas');
    });

    /**
     * A run whose input cannot be read is refused rather than promoted without
     * a brief.
     *
     * The project exists so a writer can work from it without reaching back
     * into the run; one with no topic and no goal would push that dependency
     * straight back. Refusing is visible and recoverable — creating a hollow
     * project is neither.
     */
    it('refuses a run whose brief this version cannot read', async () => {
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

      expect(response.status).toBe(409);
      expect(errorBody(response).errorCode).toBe('CONFLICT');
      expect(JSON.stringify(response.body)).toContain('was made in a form');

      // And nothing was written on the way to refusing.
      const orphan = await harness.prisma.contentProject.count({
        where: { sourceRunId: legacy.id },
      });
      expect(orphan).toBe(0);
    });
  });

  describe('the brief', () => {
    /**
     * Every shape the strict input parse refuses, not just a missing field.
     *
     * `contentIdeaInput` is `.strict()`, so an input carrying a key the current
     * schema does not know is refused as firmly as one missing a required
     * field. That is the shape a rolling deployment produces — a worker on the
     * newer image writing a run an older API then reads — and it is the case
     * most likely to appear in practice.
     */
    it.each([
      ['a missing required field', { topic: 'Kettles' }],
      [
        'an unsupported content language',
        {
          topic: 'Kettles',
          goal: 'Sell them',
          language: 'fr',
          numberOfIdeas: 3,
        },
      ],
      [
        'a key this version does not know',
        {
          topic: 'Kettles',
          goal: 'Sell them',
          language: 'en',
          numberOfIdeas: 3,
          tone: 'playful',
        },
      ],
    ])('refuses a run whose input carries %s', async (_label, input) => {
      const run = await harness.prisma.agentRun.create({
        data: {
          agentId: CONTENT_IDEA_AGENT_ID,
          agentVersion: 1,
          runtime: 'mastra',
          status: 'SUCCEEDED',
          organizationId,
          input,
          output: { ideas: IDEAS, sources: [] },
          idempotencyKey: `seed-shape-${Math.random().toString(36).slice(2)}`,
          completedAt: new Date(),
        },
        select: { id: true },
      });

      const response = await promote(owner, {
        sourceRunId: run.id,
        ideaIndex: 0,
      });

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('was made in a form');
    });

    /**
     * Snapshotted from the run's input by the server.
     *
     * The Writer Agent that will fill revision 1 consumes the project, the
     * selected idea, and the organization's knowledge — and must not have to
     * reach into `AgentRun.input` to find out what the piece is for. That is
     * why these live on the project rather than being resolved through the run
     * on every read.
     */
    it('carries the originating brief on the project detail', async () => {
      const created = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 0,
      });

      expect(created.status).toBe(201);

      const detail = await as(harness, owner).get(
        `${base()}/${dataOf<Project>(created.body).id}`,
      );

      const brief = dataOf<{ brief: Record<string, unknown> }>(
        detail.body,
      ).brief;

      expect(brief).toEqual({
        topic: RUN_INPUT.topic,
        goal: RUN_INPUT.goal,
        audience: RUN_INPUT.audience,
        guidance: RUN_INPUT.guidance,
      });
    });

    /**
     * Optional in the request means null on the project, not an empty string.
     * "The request did not say" and "the request said nothing" are different
     * facts and a writer should be able to tell them apart.
     */
    it('records an omitted audience and guidance as absent', async () => {
      const spare = await harness.prisma.agentRun.create({
        data: {
          agentId: CONTENT_IDEA_AGENT_ID,
          agentVersion: 1,
          runtime: 'mastra',
          status: 'SUCCEEDED',
          organizationId,
          input: {
            topic: 'Cordless kettles',
            goal: 'Explain the range',
            language: 'ar',
            numberOfIdeas: 3,
          },
          output: { ideas: IDEAS, sources: [] },
          idempotencyKey: `seed-spare-${Date.now()}`,
          completedAt: new Date(),
        },
        select: { id: true },
      });

      const created = await promote(owner, {
        sourceRunId: spare.id,
        ideaIndex: 0,
      });

      const detail = await as(harness, owner).get(
        `${base()}/${dataOf<Project>(created.body).id}`,
      );

      const project = dataOf<Project & { brief: Record<string, unknown> }>(
        detail.body,
      );

      expect(project.brief).toEqual({
        topic: 'Cordless kettles',
        goal: 'Explain the range',
        audience: null,
        guidance: null,
      });
      // The content language comes from the same parse — and the draft takes
      // it independently, so it is asserted independently. Hard-code the
      // draft's language and only this line fails.
      expect(project.language).toBe('ar');
      expect(project.drafts?.[0]?.language).toBe('ar');
    });

    /**
     * The brief cannot be supplied by the caller, in any shape.
     *
     * The request schema is strict, so an attempt to redirect the work by
     * sending a topic of one's own is refused outright rather than partially
     * honoured.
     */
    it('refuses a request that tries to supply its own brief', async () => {
      const response = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 0,
        topic: 'Something else entirely',
        goal: 'A different goal',
      });

      expect(response.status).toBe(400);
      expect(errorBody(response).errorCode).toBe('VALIDATION_ERROR');
    });

    /** The list stays lean; only the detail carries the brief. */
    it('keeps the brief off the list projection', async () => {
      await promote(owner, { sourceRunId: succeededRunId, ideaIndex: 0 });

      const listed = await as(harness, owner).get(base());
      const items = dataOf<{ items: Record<string, unknown>[] }>(
        listed.body,
      ).items;

      // The whole key set, not two names: `goal`, `guidance` or the stored key
      // leaking would each pass a not-toHaveProperty pair.
      expect(Object.keys(items[0] ?? {}).sort()).toEqual([
        'angle',
        'createdAt',
        'createdByUserId',
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
        'brief',
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

  describe('product audit', () => {
    const auditEventsFor = (projectId: string) =>
      harness.prisma.organizationAuditEvent.findMany({
        where: {
          organizationId,
          action: 'contentProject.created',
          subjectId: projectId,
        },
      });

    it('records exactly one event for a successful promotion', async () => {
      const created = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 1,
      });

      expect(created.status).toBe(201);

      const project = dataOf<Project>(created.body);
      const events = await auditEventsFor(project.id);

      expect(events).toHaveLength(1);

      const event = events[0];

      expect(event.actorUserId).toBe(owner.id);
      expect(event.subjectType).toBe('contentProject');
      expect(event.before).toBeNull();

      /**
       * The projection is closed, and asserted as a whole rather than field by
       * field — a sampled assertion cannot notice a field arriving.
       */
      expect(event.after).toEqual({
        kind: 'contentProject',
        projectId: project.id,
        sourceRunId: succeededRunId,
        sourceIdeaIndex: 1,
        suggestedFormat: IDEAS[1].suggestedFormat,
        language: 'en',
        draftRevision: 1,
      });
    });

    /**
     * What the projection must never carry.
     *
     * Asserted against the serialized row rather than by naming absent keys, so
     * a value that reaches the log by some other route is still caught.
     */
    it('records no key, no brief, and no generated prose', async () => {
      const key = 'audit-leak-probe-key-0001';

      const created = await promote(
        owner,
        { sourceRunId: succeededRunId, ideaIndex: 0 },
        key,
      );

      expect(created.status).toBe(201);

      const events = await auditEventsFor(dataOf<Project>(created.body).id);

      // Without this, a failed create makes `auditEventsFor(undefined)` match
      // every event in the organization and the probes below pass on an
      // unrelated row.
      expect(events).toHaveLength(1);

      const serialized = JSON.stringify(events[0]);

      expect(serialized).not.toContain(key);
      // Every brief field...
      expect(serialized).not.toContain(RUN_INPUT.topic);
      expect(serialized).not.toContain(RUN_INPUT.goal);
      expect(serialized).not.toContain(RUN_INPUT.audience);
      expect(serialized).not.toContain(RUN_INPUT.guidance);
      // ...and every prose field of the idea.
      expect(serialized).not.toContain(IDEAS[0].title);
      expect(serialized).not.toContain(IDEAS[0].hook);
      expect(serialized).not.toContain(IDEAS[0].angle);
      expect(serialized).not.toContain(IDEAS[0].summary);
    });

    /** One decision, one event, however many times the client retries. */
    it('appends nothing on an idempotent replay', async () => {
      const key = freshKey();
      const body = { sourceRunId: succeededRunId, ideaIndex: 2 };

      const first = await promote(owner, body, key);
      const projectId = dataOf<Project>(first.body).id;

      expect(await auditEventsFor(projectId)).toHaveLength(1);

      const second = await promote(owner, body, key);

      expect(dataOf<Project>(second.body).id).toBe(projectId);
      expect(await auditEventsFor(projectId)).toHaveLength(1);
    });

    it('appends nothing when two simultaneous retries race', async () => {
      const key = freshKey();
      const body = { sourceRunId: succeededRunId, ideaIndex: 0 };

      const [first, second] = await Promise.all([
        promote(owner, body, key),
        promote(owner, body, key),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(dataOf<Project>(second.body).id).toBe(
        dataOf<Project>(first.body).id,
      );

      expect(await auditEventsFor(dataOf<Project>(first.body).id)).toHaveLength(
        1,
      );
    });

    /**
     * A refusal is not a decision, so it leaves no trace.
     *
     * Counted across the whole organization rather than by subject, because a
     * refused creation has no project id to look one up by — the point is that
     * the total did not move.
     */
    it('appends nothing for a refused creation', async () => {
      const before = await harness.prisma.organizationAuditEvent.count({
        where: { organizationId, action: 'contentProject.created' },
      });

      // Not finished.
      expect(
        (await promote(owner, { sourceRunId: queuedRunId, ideaIndex: 0 }))
          .status,
      ).toBe(409);
      // No such idea.
      expect(
        (await promote(owner, { sourceRunId: succeededRunId, ideaIndex: 8 }))
          .status,
      ).toBe(400);
      // Another organization's run.
      expect(
        (
          await promote(owner, {
            sourceRunId: otherOrganizationRunId,
            ideaIndex: 0,
          })
        ).status,
      ).toBe(404);
      // A non-member of this organization.
      expect(
        (
          await promote(
            outsider,
            { sourceRunId: succeededRunId, ideaIndex: 0 },
            freshKey(),
            organizationId,
          )
        ).status,
      ).toBe(404);

      // And the two refusals that throw *inside* the transaction, which are
      // the ones that could plausibly leave an event behind.
      const unreadableInput = await harness.prisma.agentRun.create({
        data: {
          agentId: CONTENT_IDEA_AGENT_ID,
          agentVersion: 1,
          runtime: 'mastra',
          status: 'SUCCEEDED',
          organizationId,
          input: { topic: 'only' },
          output: { ideas: IDEAS, sources: [] },
          idempotencyKey: `seed-audit-input-${Date.now()}`,
          completedAt: new Date(),
        },
        select: { id: true },
      });
      const unreadableOutput = await harness.prisma.agentRun.create({
        data: {
          agentId: CONTENT_IDEA_AGENT_ID,
          agentVersion: 1,
          runtime: 'mastra',
          status: 'SUCCEEDED',
          organizationId,
          input: RUN_INPUT,
          output: { ideas: [], sources: [] },
          idempotencyKey: `seed-audit-output-${Date.now()}`,
          completedAt: new Date(),
        },
        select: { id: true },
      });

      expect(
        (
          await promote(owner, {
            sourceRunId: unreadableInput.id,
            ideaIndex: 0,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await promote(owner, {
            sourceRunId: unreadableOutput.id,
            ideaIndex: 0,
          })
        ).status,
      ).toBe(409);

      const after = await harness.prisma.organizationAuditEvent.count({
        where: { organizationId, action: 'contentProject.created' },
      });

      expect(after).toBe(before);
    });

    /**
     * The event is readable through the audit endpoint, by the roles that
     * endpoint is for.
     *
     * Writing a row nothing can read would satisfy every other test here and
     * deliver nothing: `toEntry` casts the stored projection, so a subject the
     * read path cannot represent would surface as a broken row rather than a
     * failure.
     */
    it('surfaces the event on the organization audit endpoint', async () => {
      const created = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 0,
      });

      expect(created.status).toBe(201);

      const listed = await as(harness, owner).get(
        `/organizations/${encodeURIComponent(organizationId)}/audit-events`,
      );

      expect(listed.status).toBe(200);

      const entries = dataOf<{
        items: { action: string; subjectId: string; subjectType: string }[];
      }>(listed.body).items;

      expect(
        entries.some(
          (entry) =>
            entry.action === 'contentProject.created' &&
            entry.subjectId === dataOf<Project>(created.body).id &&
            entry.subjectType === 'contentProject',
        ),
      ).toBe(true);
    });

    /**
     * Promotion history is not ordinary membership.
     *
     * The audit endpoint is gated on `organization:update`, which a plain
     * member does not hold — so adding a subject to that log must not widen who
     * can read it.
     */
    it('does not open promotion history to a plain member', async () => {
      const response = await as(harness, member).get(
        `/organizations/${encodeURIComponent(organizationId)}/audit-events`,
      );

      expect(response.status).toBe(403);
    });

    /**
     * The append shares the transaction, so a log that cannot be written takes
     * the decision with it.
     *
     * This is the property the whole arrangement exists for: a project whose
     * creation went unrecorded is a decision the audit trail denies, and that
     * is worse for a reader than a creation that visibly failed.
     *
     * The stub inspects what it is handed rather than only throwing. That
     * distinction is the test: a version of the service that passed its own
     * `PrismaService` instead of the transaction client would commit the event
     * on a separate connection while the project rolled back — exactly the
     * defect this guards — and a stub that merely threw would stay green
     * through it. Verified by making that change and watching the suite pass.
     */
    it('rolls the project and its draft back when the audit append fails', async () => {
      const audit = harness.app.get(OrganizationAuditService);
      const patched = audit as unknown as Record<string, unknown>;
      const original = patched.recordContentProjectCreation;

      const before = await harness.prisma.contentProject.count({
        where: { organizationId },
      });
      const draftsBefore = await harness.prisma.contentDraft.count({
        where: { organizationId },
      });
      const eventsBefore = await harness.prisma.organizationAuditEvent.count({
        where: { organizationId, action: 'contentProject.created' },
      });

      let sawTransactionClient: boolean | null = null;
      let sawUncommittedProject: boolean | null = null;

      patched.recordContentProjectCreation = async (
        tx: {
          contentProject: { findUnique: (args: unknown) => Promise<unknown> };
        },
        input: { projectId: string },
      ) => {
        // Not the injected client. If it were, the event would commit on its
        // own connection and outlive the rollback.
        sawTransactionClient = (tx as unknown) !== harness.prisma;

        // And the project is already written inside that transaction, so what
        // follows is a rollback rather than a failure that happened first.
        sawUncommittedProject =
          (await tx.contentProject.findUnique({
            where: { id: input.projectId },
          })) !== null;

        throw new Error('audit unavailable');
      };

      try {
        const response = await promote(owner, {
          sourceRunId: succeededRunId,
          ideaIndex: 1,
        });

        expect(response.status).toBeGreaterThanOrEqual(500);
      } finally {
        patched.recordContentProjectCreation = original;
      }

      expect(sawTransactionClient).toBe(true);
      expect(sawUncommittedProject).toBe(true);

      // Nothing survived: not the project, not its draft, not an event.
      expect(
        await harness.prisma.contentProject.count({
          where: { organizationId },
        }),
      ).toBe(before);
      expect(
        await harness.prisma.contentDraft.count({ where: { organizationId } }),
      ).toBe(draftsBefore);
      expect(
        await harness.prisma.organizationAuditEvent.count({
          where: { organizationId, action: 'contentProject.created' },
        }),
      ).toBe(eventsBefore);

      // And the endpoint still works once the log is back.
      const recovered = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 1,
      });

      expect(recovered.status).toBe(201);
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
            topic: 'Electric kettles',
            goal: 'Sell the autumn range',
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
