import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';

import { FeatureFlagService } from '../../src/control-plane';
import { KNOWLEDGE_DOCUMENT_INGESTED } from '../../src/knowledge/knowledge.events';
import { EMBEDDING_MODEL } from '../../src/knowledge/adapters/openai-embedding.adapter';
import { KnowledgeController } from '../../src/knowledge/knowledge.controller';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../support/auth-harness';

/**
 * The organization's knowledge surface, against the real application.
 *
 * Three things are only true end to end. That these routes answer for the
 * organization **in the path** rather than the one the session has selected —
 * the failure that only appears for someone who belongs to two. That the
 * feature flag actually gates writes. And that ingestion is idempotent by
 * content, which is the whole reason re-submitting a source is cheap.
 *
 * Authorization is asserted against a table of every route rather than a
 * sample, for the same reason the control-plane suite does it: the guard that
 * goes missing is always the one on the route nobody thought to probe.
 */

type SpaceBody = { id: string; slug: string; name: string };
type DocumentBody = {
  id: string;
  revision: number;
  chunkCount: number;
  changed: boolean;
  sourceUri: string | null;
};

const dataOf = <T>(body: unknown): T => (body as { data: T }).data;

const TEXT = [
  'Our refund window is thirty days from delivery.',
  'Orders placed with express shipping are dispatched the same working day.',
].join('\n\n');

describe('organization knowledge', () => {
  let harness: Harness;
  let owner: TestUser;
  let orgAdmin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let superAdmin: TestUser;
  let organizationId: string;
  let otherOrganizationId: string;
  let spaceId: string;

  const base = (id = organizationId) =>
    `/organizations/${encodeURIComponent(id)}/knowledge`;

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

  beforeAll(async () => {
    harness = await createHarness();

    owner = await createUser(harness);
    orgAdmin = await createUser(harness);
    member = await createUser(harness);
    outsider = await createUser(harness);
    superAdmin = await createUser(harness, { role: 'super_admin' });

    organizationId = await createOrganization(owner, 'knowledge-acme');
    otherOrganizationId = await createOrganization(outsider, 'knowledge-other');

    await addMember(orgAdmin, 'admin', organizationId, owner);
    await addMember(member, 'member', organizationId, owner);

    // The flag defaults to off, and every write below expects it on.
    await harness.app.get(FeatureFlagService).setPlatformOverride({
      key: 'knowledge.enabled',
      enabled: true,
      actorUserId: superAdmin.id,
    });
  });

  afterAll(async () => {
    /**
     * The flag override is platform-wide and outlives this suite, so it is
     * cleared here. The outbox rows are cleared for the same reason: nothing
     * references a deleted document, so they would accumulate in a table two
     * other suites treat as theirs to truncate.
     */
    await harness.app
      .get(FeatureFlagService)
      .clearPlatformOverride('knowledge.enabled');
    await harness.prisma.outboxEvent.deleteMany({
      where: { type: KNOWLEDGE_DOCUMENT_INGESTED },
    });
    await harness.prisma.knowledgeSpace.deleteMany({
      where: { organizationId: { in: [organizationId, otherOrganizationId] } },
    });
    await harness.close();
  });

  beforeEach(async () => {
    await harness.prisma.knowledgeSpace.deleteMany({
      where: { organizationId: { in: [organizationId, otherOrganizationId] } },
    });

    const created = await as(harness, owner).post(`${base()}/spaces`, {
      slug: 'brand',
      name: 'Brand',
    });
    expect(created.status).toBe(201);

    spaceId = dataOf<SpaceBody>(created.body).id;
  });

  describe('authorization', () => {
    /**
     * Every route, against every principal that must be refused. Removing the
     * check from one route previously left the whole suite green.
     */
    const routes = () => [
      { method: 'get' as const, path: `${base()}/spaces`, write: false },
      { method: 'post' as const, path: `${base()}/spaces`, write: true },
      {
        method: 'del' as const,
        path: `${base()}/spaces/${spaceId}`,
        write: true,
      },
      {
        method: 'get' as const,
        path: `${base()}/spaces/${spaceId}/documents`,
        write: false,
      },
      {
        method: 'put' as const,
        path: `${base()}/spaces/${spaceId}/documents`,
        write: true,
      },
      {
        method: 'del' as const,
        path: `${base()}/documents/00000000-0000-4000-8000-000000000000`,
        write: true,
      },
    ];

    /** A typed dispatch, so the table cannot index the helper with `any`. */
    const call = (user: TestUser, route: ReturnType<typeof routes>[number]) => {
      const client = as(harness, user);

      switch (route.method) {
        case 'get':
          return client.get(route.path);
        case 'post':
          return client.post(route.path);
        case 'put':
          return client.put(route.path);
        case 'del':
          return client.del(route.path);
      }
    };

    it('refuses every route to a non-member', async () => {
      for (const route of routes()) {
        const response = await call(outsider, route);

        // 404, not 403: telling a stranger the organization exists is itself
        // an answer they were not entitled to.
        expect(response.status).toBe(404);
      }
    });

    /**
     * A platform super administrator is not a member. Operating the platform
     * is not authority inside a tenant's material, and the backend says so.
     */
    it('refuses every route to a platform super administrator who is not a member', async () => {
      for (const route of routes()) {
        const response = await call(superAdmin, route);

        expect(response.status).toBe(404);
      }
    });

    /**
     * An archived organization must not answer differently to a stranger.
     *
     * `ORGANIZATION_ARCHIVED` is a 403 with its own code while every other
     * refusal here is a 404, so checking the archive before the membership
     * turns the pair into a confirmation oracle: a stranger who guessed an id
     * would learn that it names a real organization. Membership is decided
     * first, and only a member is told why it is unavailable.
     */
    it('tells a non-member nothing about an archived organization', async () => {
      await harness.prisma.organization.update({
        where: { id: organizationId },
        data: { archivedAt: new Date() },
      });

      try {
        const stranger = await as(harness, outsider).get(`${base()}/spaces`);

        expect(stranger.status).toBe(404);
        expect(errorBody(stranger).errorCode).toBe('NOT_FOUND');

        // A member still learns the real reason.
        const insider = await as(harness, owner).get(`${base()}/spaces`);

        expect(insider.status).toBe(403);
        expect(errorBody(insider).errorCode).toBe('ORGANIZATION_ARCHIVED');
      } finally {
        await harness.prisma.organization.update({
          where: { id: organizationId },
          data: { archivedAt: null },
        });
      }
    });

    it('lets a plain member read and refuses every write', async () => {
      for (const route of routes()) {
        const response = await call(member, route);

        if (route.write) {
          expect(response.status).toBe(403);
          expect(errorBody(response).errorCode).toBe('FORBIDDEN');
        } else {
          expect(response.status).toBe(200);
        }
      }
    });

    it('lets an organization admin write', async () => {
      const response = await as(harness, orgAdmin).post(`${base()}/spaces`, {
        slug: 'product',
        name: 'Product',
      });

      expect(response.status).toBe(201);
    });

    /**
     * The failure that only appears for someone in two organizations: the
     * decorator this controller deliberately does not use would authorize
     * against whichever organization the session has selected.
     */
    it('answers for the organization in the path, not the one selected', async () => {
      await as(harness, owner).post('/api/auth/organization/set-active', {
        organizationId,
      });

      const response = await as(harness, owner).get(
        `${base(otherOrganizationId)}/spaces`,
      );

      expect(response.status).toBe(404);
    });
  });

  /**
   * The listings, which the route table above cannot reach.
   *
   * Every other cross-organization case is a refusal, and a refusal is easy to
   * see. A listing that has lost its tenant predicate answers 200 with someone
   * else's rows, which looks exactly like working software — so the predicate
   * has to be asserted by its effect rather than by the absence of an error.
   */
  describe('listings are scoped to the organization in the path', () => {
    it('returns no documents from a space owned by another organization', async () => {
      const theirSpace = dataOf<{ id: string }>(
        (
          await as(harness, outsider).post(
            `${base(otherOrganizationId)}/spaces`,
            {
              slug: 'theirs',
              name: 'Theirs',
            },
          )
        ).body,
      );

      await as(harness, outsider)
        .put(`${base(otherOrganizationId)}/spaces/${theirSpace.id}/documents`, {
          title: 'Their handbook',
          content: TEXT,
        })
        .expect(200);

      // The caller is authorized for their own organization and names a space
      // id belonging to another. The space predicate alone would return it.
      const response = await as(harness, owner).get(
        `${base()}/spaces/${theirSpace.id}/documents`,
      );

      expect(response.status).toBe(200);
      expect(dataOf<unknown[]>(response.body)).toEqual([]);
    });

    it('lists only the caller organization own spaces', async () => {
      await as(harness, outsider)
        .post(`${base(otherOrganizationId)}/spaces`, {
          slug: 'brand',
          name: 'Their brand',
        })
        .expect(201);

      const response = await as(harness, owner).get(`${base()}/spaces`);

      const spaces = dataOf<{ id: string; name: string }[]>(response.body);

      expect(spaces.length).toBeGreaterThan(0);
      expect(spaces.map((space) => space.name)).not.toContain('Their brand');

      const owned = await harness.prisma.knowledgeSpace.findMany({
        where: { id: { in: spaces.map((space) => space.id) } },
        select: { organizationId: true },
      });

      expect(
        owned.every((space) => space.organizationId === organizationId),
      ).toBe(true);
    });
  });

  describe('spaces', () => {
    it('refuses a second space with the same slug', async () => {
      const response = await as(harness, owner).post(`${base()}/spaces`, {
        slug: 'brand',
        name: 'Brand again',
      });

      expect(response.status).toBe(409);
      expect(errorBody(response).errorCode).toBe('CONFLICT');
    });

    it('lets another organization use the same slug', async () => {
      const response = await as(harness, outsider).post(
        `${base(otherOrganizationId)}/spaces`,
        { slug: 'brand', name: 'Brand' },
      );

      expect(response.status).toBe(201);
    });

    it.each(['Brand', 'has space', 'trailing-', 'ümlaut'])(
      'refuses the slug %p',
      async (slug) => {
        const response = await as(harness, owner).post(`${base()}/spaces`, {
          slug,
          name: 'Whatever',
        });

        expect(response.status).toBe(400);
      },
    );

    it('will not delete a space through another organization', async () => {
      const response = await as(harness, outsider).del(
        `${base(otherOrganizationId)}/spaces/${spaceId}`,
      );

      expect(response.status).toBe(404);
    });

    it('takes the documents with it', async () => {
      await as(harness, owner)
        .put(`${base()}/spaces/${spaceId}/documents`, {
          title: 'Policies',
          content: TEXT,
        })
        .expect(200);

      await as(harness, owner).del(`${base()}/spaces/${spaceId}`).expect(200);

      expect(
        await harness.prisma.knowledgeChunk.count({ where: { spaceId } }),
      ).toBe(0);
    });
  });

  describe('ingestion', () => {
    const ingest = (body: Record<string, unknown>) =>
      as(harness, owner).put(`${base()}/spaces/${spaceId}/documents`, body);

    it('stores a document as chunks and queues the embedding', async () => {
      const response = await ingest({ title: 'Policies', content: TEXT });

      expect(response.status).toBe(200);

      const document = dataOf<DocumentBody>(response.body);
      expect(document.changed).toBe(true);
      expect(document.revision).toBe(1);
      expect(document.chunkCount).toBeGreaterThan(0);

      const chunks = await harness.prisma.knowledgeChunk.count({
        where: { documentId: document.id },
      });
      expect(chunks).toBe(document.chunkCount);

      // The work is durable before anything is published. Scoped to this
      // document and asserted exactly: an unscoped `> 0` over a table the
      // suite never clears is satisfied by an earlier test's event.
      const events = await harness.prisma.outboxEvent.count({
        where: {
          type: 'knowledge-document.ingested',
          payload: { path: ['documentId'], equals: document.id },
        },
      });
      expect(events).toBe(1);
    });

    /**
     * Re-ingesting a source is the ordinary way it is kept current, so
     * unchanged text has to be free: re-embedding it is a provider bill for an
     * identical result.
     */
    /**
     * A source reference is returned by the listing, so the first screen that
     * renders it as a link inherits whatever is stored. Browser-only schemes
     * are refused at the edge rather than left for that screen to remember.
     */
    it('refuses a source reference that carries a script scheme', async () => {
      for (const sourceUri of [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        '  JavaScript:alert(1)',
      ]) {
        const response = await ingest({
          title: 'Policies',
          content: TEXT,
          sourceUri,
        });

        expect(response.status).toBe(400);
      }
    });

    it('accepts the source references people actually use', async () => {
      for (const sourceUri of [
        'https://example.test/handbook',
        'docs/policies.md',
        'Pasted from the support wiki on Tuesday',
      ]) {
        const response = await ingest({
          title: 'Policies',
          content: TEXT,
          sourceUri,
        });

        expect(response.status).toBe(200);
      }
    });

    it('does not revise or re-chunk when the text has not changed', async () => {
      const first = dataOf<DocumentBody>(
        (await ingest({ title: 'Policies', content: TEXT })).body,
      );

      const second = dataOf<DocumentBody>(
        (await ingest({ title: 'Policies', content: TEXT })).body,
      );

      expect(second.id).toBe(first.id);
      expect(second.changed).toBe(false);
      expect(second.revision).toBe(1);
      expect(second.chunkCount).toBe(first.chunkCount);
    });

    /**
     * The property the fast path exists for: an already-embedded document that
     * is submitted again costs nothing. Chunks are marked as carrying the
     * current model first, because no worker runs here and unembedded chunks
     * are legitimately owed a delivery.
     */
    it('asks for no embedding when unchanged text is already embedded', async () => {
      const first = dataOf<DocumentBody>(
        (await ingest({ title: 'Policies', content: TEXT })).body,
      );

      await harness.prisma.knowledgeChunk.updateMany({
        where: { documentId: first.id },
        data: { embeddingModel: EMBEDDING_MODEL },
      });

      const before = await harness.prisma.outboxEvent.count({
        where: { type: 'knowledge-document.ingested' },
      });

      await ingest({ title: 'Policies', content: TEXT });

      expect(
        await harness.prisma.outboxEvent.count({
          where: { type: 'knowledge-document.ingested' },
        }),
      ).toBe(before);
    });

    /**
     * The recovery path, and the reason the fast path cannot simply return.
     *
     * Embedding runs in the worker and can exhaust its attempts — configuring
     * the provider credential after storing a document is enough to fail every
     * one. Submitting the document again is what an operator will try, and it
     * is recognized as unchanged; without a re-request the document would stay
     * invisible to retrieval forever while the screen reported its passages.
     */
    it('re-requests embedding for unchanged text that never got a vector', async () => {
      await ingest({ title: 'Policies', content: TEXT });

      const before = await harness.prisma.outboxEvent.count({
        where: { type: 'knowledge-document.ingested' },
      });

      const second = dataOf<DocumentBody>(
        (await ingest({ title: 'Policies', content: TEXT })).body,
      );

      expect(second.changed).toBe(false);
      expect(second.revision).toBe(1);
      expect(
        await harness.prisma.outboxEvent.count({
          where: { type: 'knowledge-document.ingested' },
        }),
      ).toBe(before + 1);
    });

    /**
     * Without a dedupe key, deliberately. The key becomes BullMQ's job id and
     * the failed job for this revision is retained, so a repair carrying it
     * would be discarded as a duplicate of the delivery that already failed.
     */
    it('sends the repair request without a deduplication key', async () => {
      const first = dataOf<DocumentBody>(
        (await ingest({ title: 'Policies', content: TEXT })).body,
      );

      await ingest({ title: 'Policies', content: TEXT });

      // Scoped to this document: the suite's other tests append here too.
      const events = await harness.prisma.outboxEvent.findMany({
        where: {
          type: 'knowledge-document.ingested',
          payload: { path: ['documentId'], equals: first.id },
        },
        orderBy: { createdAt: 'asc' },
        select: { dedupeKey: true },
      });

      expect(events).toHaveLength(2);
      expect(events[0]?.dedupeKey).toBe(`${first.id}:1`);
      expect(events[1]?.dedupeKey).toBeNull();
    });

    /**
     * The reference to where text came from is not part of what is
     * content-addressed, so correcting it must not require perturbing the text.
     */
    it('corrects the source reference without revising the document', async () => {
      const first = dataOf<DocumentBody>(
        (
          await ingest({
            title: 'Policies',
            content: TEXT,
            sourceUri: 'https://example.test/typo',
          })
        ).body,
      );

      const second = dataOf<DocumentBody>(
        (
          await ingest({
            title: 'Policies',
            content: TEXT,
            sourceUri: 'https://example.test/correct',
          })
        ).body,
      );

      expect(second.id).toBe(first.id);
      expect(second.changed).toBe(false);
      expect(second.revision).toBe(1);
      expect(second.sourceUri).toBe('https://example.test/correct');

      const stored = await harness.prisma.knowledgeDocument.findUniqueOrThrow({
        where: { id: first.id },
        select: { sourceUri: true },
      });

      expect(stored.sourceUri).toBe('https://example.test/correct');
    });

    it('replaces the chunks when the text changes, leaving none of the old ones', async () => {
      const first = dataOf<DocumentBody>(
        (await ingest({ title: 'Policies', content: TEXT })).body,
      );

      const oldChunks = await harness.prisma.knowledgeChunk.findMany({
        where: { documentId: first.id },
        select: { id: true },
      });

      const second = dataOf<DocumentBody>(
        (
          await ingest({
            title: 'Policies',
            content: 'The refund window is now sixty days from delivery.',
          })
        ).body,
      );

      expect(second.id).toBe(first.id);
      expect(second.changed).toBe(true);
      expect(second.revision).toBe(2);

      const surviving = await harness.prisma.knowledgeChunk.count({
        where: { id: { in: oldChunks.map((chunk) => chunk.id) } },
      });
      expect(surviving).toBe(0);
    });

    /**
     * The dedupe key becomes BullMQ's job id. Keyed on the document alone, a
     * second edit would be discarded as a repeat of the first while the queue's
     * retention still held it — and revision 2's chunks would never be
     * embedded, silently, with the screen showing them stored.
     */
    it('gives each revision its own delivery key', async () => {
      const first = dataOf<DocumentBody>(
        (await ingest({ title: 'Policies', content: TEXT })).body,
      );

      await ingest({
        title: 'Policies',
        content: 'The refund window is now sixty days.',
      });

      const keys = await harness.prisma.outboxEvent.findMany({
        where: {
          type: 'knowledge-document.ingested',
          dedupeKey: { startsWith: first.id },
        },
        select: { dedupeKey: true },
      });

      expect(keys).toHaveLength(2);
      expect(new Set(keys.map((event) => event.dedupeKey)).size).toBe(2);
    });

    it('refuses text with nothing in it', async () => {
      const response = await ingest({ title: 'Empty', content: '   \n\n  ' });

      expect(response.status).toBe(400);
    });

    it('refuses a space belonging to another organization', async () => {
      const theirs = dataOf<SpaceBody>(
        (
          await as(harness, outsider).post(
            `${base(otherOrganizationId)}/spaces`,
            { slug: 'theirs', name: 'Theirs' },
          )
        ).body,
      );

      const response = await as(harness, owner).put(
        `${base()}/spaces/${theirs.id}/documents`,
        { title: 'Smuggled', content: TEXT },
      );

      expect(response.status).toBe(404);
    });

    it('deletes a document and its chunks', async () => {
      const document = dataOf<DocumentBody>(
        (await ingest({ title: 'Policies', content: TEXT })).body,
      );

      await as(harness, owner)
        .del(`${base()}/documents/${document.id}`)
        .expect(200);

      expect(
        await harness.prisma.knowledgeChunk.count({
          where: { documentId: document.id },
        }),
      ).toBe(0);
    });

    it('will not delete a document through another organization', async () => {
      const document = dataOf<DocumentBody>(
        (await ingest({ title: 'Policies', content: TEXT })).body,
      );

      const response = await as(harness, outsider).del(
        `${base(otherOrganizationId)}/documents/${document.id}`,
      );

      expect(response.status).toBe(404);

      expect(
        await harness.prisma.knowledgeDocument.count({
          where: { id: document.id },
        }),
      ).toBe(1);
    });
  });

  /**
   * The flag refuses *new* work. It does not hide what an organization already
   * has — an operator switching ingestion off to stop a cost is not asking for
   * the existing material to disappear from the screen.
   */
  describe('feature gating', () => {
    const flags = () => harness.app.get(FeatureFlagService);

    it('refuses writes and still serves reads when disabled', async () => {
      await as(harness, owner)
        .put(`${base()}/spaces/${spaceId}/documents`, {
          title: 'Policies',
          content: TEXT,
        })
        .expect(200);

      await flags().setOrganizationOverride({
        key: 'knowledge.enabled',
        organizationId,
        enabled: false,
        actorUserId: superAdmin.id,
      });

      try {
        const refused = await as(harness, owner).put(
          `${base()}/spaces/${spaceId}/documents`,
          { title: 'Another', content: TEXT },
        );

        expect(refused.status).toBe(403);
        expect(errorBody(refused).errorCode).toBe('FEATURE_DISABLED');

        const creating = await as(harness, owner).post(`${base()}/spaces`, {
          slug: 'blocked',
          name: 'Blocked',
        });
        expect(creating.status).toBe(403);

        const reading = await as(harness, owner).get(
          `${base()}/spaces/${spaceId}/documents`,
        );
        expect(reading.status).toBe(200);
        expect(dataOf<unknown[]>(reading.body)).toHaveLength(1);
      } finally {
        await flags().clearOrganizationOverride({
          key: 'knowledge.enabled',
          organizationId,
        });
      }
    });

    /**
     * Deletion is deliberately outside the gate, and that has to be pinned
     * rather than left to be rediscovered as a bug. The flag refuses new work;
     * an operator switching knowledge off is the likeliest person to want the
     * material gone, and a kill switch that locked the data in place would be
     * the wrong shape.
     */
    it('still allows removal when disabled', async () => {
      const document = dataOf<DocumentBody>(
        (
          await as(harness, owner).put(
            `${base()}/spaces/${spaceId}/documents`,
            { title: 'Removable', content: TEXT },
          )
        ).body,
      );

      const doomed = dataOf<{ id: string }>(
        (
          await as(harness, owner).post(`${base()}/spaces`, {
            slug: 'doomed',
            name: 'Doomed',
          })
        ).body,
      );

      await flags().setOrganizationOverride({
        key: 'knowledge.enabled',
        organizationId,
        enabled: false,
        actorUserId: superAdmin.id,
      });

      try {
        await as(harness, owner)
          .del(`${base()}/documents/${document.id}`)
          .expect(200);

        await as(harness, owner)
          .del(`${base()}/spaces/${doomed.id}`)
          .expect(200);

        expect(
          await harness.prisma.knowledgeDocument.count({
            where: { id: document.id },
          }),
        ).toBe(0);
        expect(
          await harness.prisma.knowledgeSpace.count({
            where: { id: doomed.id },
          }),
        ).toBe(0);
      } finally {
        await flags().clearOrganizationOverride({
          key: 'knowledge.enabled',
          organizationId,
        });
      }
    });

    it('leaves another organization unaffected', async () => {
      await flags().setOrganizationOverride({
        key: 'knowledge.enabled',
        organizationId,
        enabled: false,
        actorUserId: superAdmin.id,
      });

      try {
        const response = await as(harness, outsider).post(
          `${base(otherOrganizationId)}/spaces`,
          { slug: 'unaffected', name: 'Unaffected' },
        );

        expect(response.status).toBe(201);
      } finally {
        await flags().clearOrganizationOverride({
          key: 'knowledge.enabled',
          organizationId,
        });
      }
    });
  });

  it('never returns chunk text from a listing', async () => {
    await as(harness, owner)
      .put(`${base()}/spaces/${spaceId}/documents`, {
        title: 'Policies',
        content: TEXT,
      })
      .expect(200);

    const response = await as(harness, owner).get(
      `${base()}/spaces/${spaceId}/documents`,
    );

    // The listing is metadata. Serving the whole corpus from an index route
    // would make every page load carry the organization's material.
    expect(JSON.stringify(response.body)).not.toContain('refund window');
  });

  it('is the controller the API composes', () => {
    expect(harness.app.get(KnowledgeController)).toBeInstanceOf(
      KnowledgeController,
    );
  });
});
