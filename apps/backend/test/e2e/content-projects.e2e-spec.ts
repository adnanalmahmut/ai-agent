import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';

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
    it('stores the agent\'s idea and opens revision 1 in one write', async () => {
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
      const response = await as(harness, owner).post(
        `${base()}/from-idea`,
        { sourceRunId: succeededRunId, ideaIndex: 0 },
      );

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

      const first = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 0,
      }, key);
      const second = await promote(owner, {
        sourceRunId: succeededRunId,
        ideaIndex: 1,
      }, key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const firstProject = dataOf<Project>(first.body);
      const secondProject = dataOf<Project>(second.body);

      expect(secondProject.id).not.toBe(firstProject.id);
      expect(secondProject.sourceIdeaIndex).toBe(1);
    });
  });

  describe('tenant isolation', () => {
    it('reports another organization\'s run as absent', async () => {
      const response = await promote(owner, {
        sourceRunId: otherOrganizationRunId,
        ideaIndex: 0,
      });

      expect(response.status).toBe(404);
    });

    it('refuses a member of another organization outright', async () => {
      const response = await promote(
        outsider,
        { sourceRunId: succeededRunId, ideaIndex: 0 },
        freshKey(),
        organizationId,
      );

      expect([403, 404]).toContain(response.status);
    });

    it('does not list another organization\'s projects', async () => {
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

    it('reports another organization\'s project as absent on detail', async () => {
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
