import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';

import { FeatureFlagService } from '../../src/features/control-plane';
import { KNOWLEDGE_SPACE_SLUGS } from '../../src/features/knowledge/knowledge-space.registry';
import { KNOWLEDGE_DOCUMENT_INGESTED } from '../../src/features/knowledge/knowledge.events';
import { EMBEDDING_MODEL } from '../../src/features/knowledge/adapters/openai-embedding.adapter';
import { KnowledgeController } from '../../src/features/knowledge/knowledge.controller';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../support/auth-harness';

/**
 * The actor recorded on control-plane writes this harness makes.
 *
 * The audit log records who changed a flag, and these setups change flags — so
 * every call has to name somebody. A fixed non-user id rather than a session
 * user: the events are the harness's own, and attributing them to a test member
 * would put rows in the log that read as though a member of the organization
 * had reached the operator surface.
 */
const CONTROL_PLANE_ACTOR = 'e2e-harness';

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

type SpaceBody = {
  slug: string;
  name: string;
  description: string;
  configured: boolean;
  documentCount: number;
};

type DocumentPage = { items: DocumentBody[]; nextCursor: string | null };
type DocumentBody = {
  id: string;
  title: string;
  revision: number;
  chunkCount: number;
  changed: boolean;
  sourceUri: string | null;
  updatedAt: string;
};

const dataOf = <T>(body: unknown): T => (body as { data: T }).data;

/**
 * The two registry slugs this suite writes under.
 *
 * Registry members rather than invented strings, because there is no longer a
 * route that would accept an invented one — which is the point of the redesign
 * and is asserted directly further down.
 */
const SLUG = 'brand.voice';
const OTHER_SLUG = 'products.services';

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
    await harness.app.get(FeatureFlagService).clearPlatformOverride({
      key: 'knowledge.enabled',
      actorUserId: CONTROL_PLANE_ACTOR,
    });
    await harness.prisma.outboxEvent.deleteMany({
      where: { type: KNOWLEDGE_DOCUMENT_INGESTED },
    });
    await harness.prisma.knowledgeSpace.deleteMany({
      where: { organizationId: { in: [organizationId, otherOrganizationId] } },
    });
    await harness.close();
  });

  beforeEach(async () => {
    /**
     * No space is created here, and there is no route that would.
     *
     * The taxonomy is code-owned: the eight spaces exist in the registry
     * whether or not this organization has stored anything, and the row appears
     * on first ingestion inside that ingestion's own transaction. Clearing the
     * rows is therefore the whole of the reset.
     */
    await harness.prisma.knowledgeSpace.deleteMany({
      where: { organizationId: { in: [organizationId, otherOrganizationId] } },
    });
  });

  describe('authorization', () => {
    /**
     * Every route, against every principal that must be refused. Removing the
     * check from one route previously left the whole suite green.
     */
    const routes = () => [
      { method: 'get' as const, path: `${base()}/spaces`, write: false },
      {
        method: 'del' as const,
        path: `${base()}/spaces/${SLUG}`,
        write: true,
      },
      {
        method: 'get' as const,
        path: `${base()}/spaces/${SLUG}/documents`,
        write: false,
      },
      {
        method: 'put' as const,
        path: `${base()}/spaces/${SLUG}/documents`,
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
      const response = await as(harness, orgAdmin).put(
        `${base()}/spaces/${OTHER_SLUG}/documents`,
        { title: 'Product notes', content: TEXT },
      );

      expect(response.status).toBe(200);
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
    /**
     * The slug is now the same string in every organization, which makes this
     * the sharper version of the old test rather than a weaker one: the caller
     * names a space that genuinely exists for somebody else, spelled exactly
     * as it is spelled there, and the only thing standing between them and its
     * contents is the tenant predicate.
     */
    it('returns no documents from another organization space of the same name', async () => {
      await as(harness, outsider)
        .put(`${base(otherOrganizationId)}/spaces/${SLUG}/documents`, {
          title: 'Their handbook',
          content: TEXT,
        })
        .expect(200);

      const response = await as(harness, owner).get(
        `${base()}/spaces/${SLUG}/documents`,
      );

      expect(response.status).toBe(200);
      expect(dataOf<DocumentPage>(response.body).items).toEqual([]);
    });

    it('counts only the caller organization own documents', async () => {
      await as(harness, outsider)
        .put(`${base(otherOrganizationId)}/spaces/${SLUG}/documents`, {
          title: 'Their handbook',
          content: TEXT,
        })
        .expect(200);

      const response = await as(harness, owner).get(`${base()}/spaces`);
      const spaces = dataOf<SpaceBody[]>(response.body);

      // The taxonomy is the same eight for everyone; what is scoped is what has
      // been stored in it.
      expect(spaces).toHaveLength(KNOWLEDGE_SPACE_SLUGS.length);
      expect(spaces.every((space) => space.documentCount === 0)).toBe(true);
      expect(spaces.every((space) => !space.configured)).toBe(true);
    });
  });

  describe('spaces', () => {
    /**
     * The taxonomy is the application's, and the listing says so before
     * anything has been stored.
     *
     * This is the property the whole redesign rests on: a customer cannot
     * invent a space, so there is nothing to create and nothing to name. What
     * the screen shows is the eight the code declares, annotated with what this
     * organization has put in them.
     */
    it('returns the whole registry, including spaces nothing is stored in', async () => {
      const response = await as(harness, owner).get(`${base()}/spaces`);

      expect(response.status).toBe(200);

      const spaces = dataOf<SpaceBody[]>(response.body);

      expect(spaces.map((space) => space.slug)).toEqual([
        ...KNOWLEDGE_SPACE_SLUGS,
      ]);
      expect(spaces.every((space) => space.name.length > 0)).toBe(true);
      expect(spaces.every((space) => space.description.length > 0)).toBe(true);
    });

    it('reports a space as configured once something is in it', async () => {
      await as(harness, owner)
        .put(`${base()}/spaces/${SLUG}/documents`, {
          title: 'Policies',
          content: TEXT,
        })
        .expect(200);

      const spaces = dataOf<SpaceBody[]>(
        (await as(harness, owner).get(`${base()}/spaces`)).body,
      );
      const stored = spaces.find((space) => space.slug === SLUG);

      expect(stored).toMatchObject({ configured: true, documentCount: 1 });
      expect(
        spaces
          .filter((space) => space.slug !== SLUG)
          .every((s) => !s.configured),
      ).toBe(true);
    });

    /**
     * An unregistered slug is unpersistable through the application, which is
     * the guarantee that replaced the old free-text field. 404 rather than 400:
     * it names no resource, the same answer another organization's material
     * gets.
     */
    it.each([
      'brand',
      'Brand.Voice',
      'products',
      'anything-a-customer-invents',
      'constructor',
      '__proto__',
    ])('refuses the unregistered slug %p', async (slug) => {
      const write = await as(harness, owner).put(
        `${base()}/spaces/${encodeURIComponent(slug)}/documents`,
        { title: 'Whatever', content: TEXT },
      );

      expect(write.status).toBe(404);

      const read = await as(harness, owner).get(
        `${base()}/spaces/${encodeURIComponent(slug)}/documents`,
      );

      expect(read.status).toBe(404);

      // And nothing was written under it.
      expect(
        await harness.prisma.knowledgeSpace.count({ where: { slug } }),
      ).toBe(0);
    });

    it('answers an empty page for a registered space nothing is stored in', async () => {
      const response = await as(harness, owner).get(
        `${base()}/spaces/${SLUG}/documents`,
      );

      expect(response.status).toBe(200);
      expect(dataOf<DocumentPage>(response.body)).toEqual({
        items: [],
        nextCursor: null,
      });
    });

    it('empties one space without touching another organization', async () => {
      await as(harness, outsider)
        .put(`${base(otherOrganizationId)}/spaces/${SLUG}/documents`, {
          title: 'Theirs',
          content: TEXT,
        })
        .expect(200);
      await as(harness, owner)
        .put(`${base()}/spaces/${SLUG}/documents`, {
          title: 'Policies',
          content: TEXT,
        })
        .expect(200);

      await as(harness, owner).del(`${base()}/spaces/${SLUG}`).expect(200);

      expect(
        await harness.prisma.knowledgeChunk.count({
          where: { organizationId },
        }),
      ).toBe(0);
      expect(
        await harness.prisma.knowledgeChunk.count({
          where: { organizationId: otherOrganizationId },
        }),
      ).toBeGreaterThan(0);
    });

    /** Emptying a space it has nothing in is a 404, not a silent success. */
    it('refuses to empty a space this organization has never used', async () => {
      const response = await as(harness, owner).del(`${base()}/spaces/${SLUG}`);

      expect(response.status).toBe(404);
    });
  });

  describe('ingestion', () => {
    const ingest = (body: Record<string, unknown>) =>
      as(harness, owner).put(`${base()}/spaces/${SLUG}/documents`, body);

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

    /**
     * The response has to describe the row *after* the write, not before it.
     *
     * `updatedAt` carries `@updatedAt`, so correcting a `sourceUri` bumps it —
     * and the unchanged-content path used to answer with the value it had read
     * a moment earlier, reporting the timestamp of the change *before* this
     * one. A client that stores what it is told and uses it to decide whether
     * its copy is current would conclude its stale copy is the newest, which is
     * the one question this field exists to answer.
     *
     * Asserted against the committed row rather than against a clock, so it
     * cannot pass by the two happening to be close together.
     */
    it('reports the timestamp the source-reference correction committed', async () => {
      const first = dataOf<DocumentBody>(
        (
          await ingest({
            title: 'Policies',
            content: TEXT,
            sourceUri: 'https://example.test/typo',
          })
        ).body,
      );

      const corrected = dataOf<DocumentBody>(
        (
          await ingest({
            title: 'Policies',
            content: TEXT,
            sourceUri: 'https://example.test/correct',
          })
        ).body,
      );

      const stored = await harness.prisma.knowledgeDocument.findUniqueOrThrow({
        where: { id: first.id },
        select: { sourceUri: true, updatedAt: true, revision: true },
      });

      // The returned `updatedAt` is the committed one, not the pre-update one.
      expect(corrected.updatedAt).toBe(stored.updatedAt.toISOString());
      expect(corrected.updatedAt).not.toBe(first.updatedAt);
      expect(new Date(corrected.updatedAt).getTime()).toBeGreaterThan(
        new Date(first.updatedAt).getTime(),
      );

      // And the things a source-reference correction must not do.
      expect(stored.revision).toBe(1);
      expect(corrected.revision).toBe(1);
      expect(corrected.changed).toBe(false);
    });

    /**
     * The other half: a genuinely unchanged submission writes nothing, so the
     * timestamp must *not* move. Without this the fix above could be a blanket
     * `updatedAt: new Date()` on every re-ingestion, which would be a write on
     * the path whose whole purpose is not to write.
     */
    it('leaves the timestamp alone when nothing at all changed', async () => {
      const first = dataOf<DocumentBody>(
        (
          await ingest({
            title: 'Policies',
            content: TEXT,
            sourceUri: 'https://example.test/same',
          })
        ).body,
      );

      const again = dataOf<DocumentBody>(
        (
          await ingest({
            title: 'Policies',
            content: TEXT,
            sourceUri: 'https://example.test/same',
          })
        ).body,
      );

      const stored = await harness.prisma.knowledgeDocument.findUniqueOrThrow({
        where: { id: first.id },
        select: { updatedAt: true },
      });

      expect(again.updatedAt).toBe(first.updatedAt);
      expect(stored.updatedAt.toISOString()).toBe(first.updatedAt);
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

    /**
     * Ingesting into a space another organization has already used stores a row
     * for *this* organization rather than writing into theirs.
     *
     * The old version of this asserted a 404 on a space id belonging to
     * somebody else. There are no space ids on the surface any more, so the
     * question changes shape: the slug is the same string for everyone, and
     * what must hold is that the row `ensure` writes carries the caller's
     * tenant. A `where` that had lost `organizationId` would silently make the
     * two organizations share one space.
     */
    it('writes into this organization space, not the neighbour one of the same name', async () => {
      await as(harness, outsider)
        .put(`${base(otherOrganizationId)}/spaces/${SLUG}/documents`, {
          title: 'Theirs',
          content: TEXT,
        })
        .expect(200);

      await ingest({ title: 'Ours', content: TEXT });

      const spaces = await harness.prisma.knowledgeSpace.findMany({
        where: {
          slug: SLUG,
          organizationId: { in: [organizationId, otherOrganizationId] },
        },
        select: { organizationId: true },
      });

      // Two rows, one per tenant — not one row shared.
      expect(spaces).toHaveLength(2);
      expect(new Set(spaces.map((space) => space.organizationId)).size).toBe(2);
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
        .put(`${base()}/spaces/${SLUG}/documents`, {
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
          `${base()}/spaces/${SLUG}/documents`,
          { title: 'Another', content: TEXT },
        );

        expect(refused.status).toBe(403);
        expect(errorBody(refused).errorCode).toBe('FEATURE_DISABLED');

        // Including into a space this organization has not used yet, which is
        // the path that would create the row: the gate is checked before the
        // transaction that ensures it opens.
        const opening = await as(harness, owner).put(
          `${base()}/spaces/${OTHER_SLUG}/documents`,
          { title: 'Blocked', content: TEXT },
        );
        expect(opening.status).toBe(403);
        expect(errorBody(opening).errorCode).toBe('FEATURE_DISABLED');
        expect(
          await harness.prisma.knowledgeSpace.count({
            where: { organizationId, slug: OTHER_SLUG },
          }),
        ).toBe(0);

        // Both reads still answer. Disabling a feature refuses new work; it
        // does not hide what an organization already has.
        const reading = await as(harness, owner).get(
          `${base()}/spaces/${SLUG}/documents`,
        );
        expect(reading.status).toBe(200);
        expect(dataOf<DocumentPage>(reading.body).items).toHaveLength(1);

        const listing = await as(harness, owner).get(`${base()}/spaces`);
        expect(listing.status).toBe(200);
      } finally {
        await flags().clearOrganizationOverride({
          actorUserId: CONTROL_PLANE_ACTOR,
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
          await as(harness, owner).put(`${base()}/spaces/${SLUG}/documents`, {
            title: 'Removable',
            content: TEXT,
          })
        ).body,
      );

      await as(harness, owner)
        .put(`${base()}/spaces/${OTHER_SLUG}/documents`, {
          title: 'Doomed',
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
        await as(harness, owner)
          .del(`${base()}/documents/${document.id}`)
          .expect(200);

        await as(harness, owner)
          .del(`${base()}/spaces/${OTHER_SLUG}`)
          .expect(200);

        expect(
          await harness.prisma.knowledgeDocument.count({
            where: { id: document.id },
          }),
        ).toBe(0);
        expect(
          await harness.prisma.knowledgeSpace.count({
            where: { organizationId, slug: OTHER_SLUG },
          }),
        ).toBe(0);
      } finally {
        await flags().clearOrganizationOverride({
          actorUserId: CONTROL_PLANE_ACTOR,
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
        const response = await as(harness, outsider).put(
          `${base(otherOrganizationId)}/spaces/${OTHER_SLUG}/documents`,
          { title: 'Unaffected', content: TEXT },
        );

        expect(response.status).toBe(200);
      } finally {
        await flags().clearOrganizationOverride({
          actorUserId: CONTROL_PLANE_ACTOR,
          key: 'knowledge.enabled',
          organizationId,
        });
      }
    });
  });

  /**
   * Paging, against a real database.
   *
   * The old listing returned up to two hundred rows and then stopped, silently
   * — a client had no way to tell a space with exactly two hundred documents
   * from one with a thousand. What replaces it is keyset paging, and the two
   * properties worth asserting end to end are that the sequence is complete and
   * that a cursor grants nothing.
   */
  describe('document paging', () => {
    /** Titles chosen so lexical order and insertion order disagree. */
    const TITLES = [
      'Delta note',
      'Alpha note',
      'Echo note',
      'Bravo note',
      'Charlie note',
    ];

    const seed = async (target = organizationId, user = owner) => {
      for (const title of TITLES) {
        await as(harness, user)
          .put(`${base(target)}/spaces/${SLUG}/documents`, {
            title,
            content: `${TEXT}\n\n${title}`,
          })
          .expect(200);
      }
    };

    const page = (query: string, user = owner, target = organizationId) =>
      as(harness, user).get(`${base(target)}/spaces/${SLUG}/documents${query}`);

    it('walks the whole collection exactly once, in a stable order', async () => {
      await seed();

      const seen: string[] = [];
      let cursor: string | null = null;
      let requests = 0;

      do {
        const response = await page(
          `?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
        );

        expect(response.status).toBe(200);

        const body = dataOf<DocumentPage>(response.body);

        expect(body.items.length).toBeLessThanOrEqual(2);
        seen.push(...body.items.map((item) => item.title));
        cursor = body.nextCursor;
        requests += 1;

        // A cursor that never advanced would loop until the suite timed out.
        expect(requests).toBeLessThan(10);
      } while (cursor !== null);

      // Every document, once, in title order — not insertion order.
      expect(seen).toEqual([...TITLES].sort());
      expect(new Set(seen).size).toBe(TITLES.length);
    });

    /**
     * The last page must not emit a cursor.
     *
     * A `nextCursor` returned whenever a page came back full leaves a client
     * fetching one empty page at the end of every collection whose size divides
     * evenly by the page size — which is why the query reads one row more than
     * it returns.
     */
    it('stops without a cursor when the collection divides evenly', async () => {
      await seed();

      const first = dataOf<DocumentPage>((await page('?limit=5')).body);

      expect(first.items).toHaveLength(5);
      expect(first.nextCursor).toBeNull();
    });

    it('refuses a page size beyond the server ceiling rather than clamping it', async () => {
      const response = await page('?limit=5000');

      expect(response.status).toBe(400);
      expect(errorBody(response).errorCode).toBe('VALIDATION_ERROR');
    });

    it.each(['?limit=0', '?limit=-1', '?cursor=not-a-cursor'])(
      'refuses %s',
      async (query) => {
        expect((await page(query)).status).toBe(400);
      },
    );

    /**
     * A cursor is a position, not a capability.
     *
     * The strongest available statement: take a cursor minted while paging
     * another organization's identically-named space and present it here. The
     * tenant predicate stays in the query, so it can only position over rows
     * this caller could already read — it cannot redirect the listing, and it
     * cannot leak the neighbour's titles.
     */
    it('does not let a cursor from another organization reach its rows', async () => {
      await seed(otherOrganizationId, outsider);
      await as(harness, owner)
        .put(`${base()}/spaces/${SLUG}/documents`, {
          title: 'Ours only',
          content: TEXT,
        })
        .expect(200);

      const theirs = dataOf<DocumentPage>(
        (await page('?limit=1', outsider, otherOrganizationId)).body,
      );

      expect(theirs.nextCursor).not.toBeNull();

      const response = await page(
        `?limit=10&cursor=${encodeURIComponent(theirs.nextCursor!)}`,
      );

      expect(response.status).toBe(200);

      const titles = dataOf<DocumentPage>(response.body).items.map(
        (item) => item.title,
      );

      for (const title of TITLES) {
        expect(titles).not.toContain(title);
      }
      expect(JSON.stringify(response.body)).not.toContain('Delta note');
    });
  });

  it('never returns chunk text from a listing', async () => {
    await as(harness, owner)
      .put(`${base()}/spaces/${SLUG}/documents`, {
        title: 'Policies',
        content: TEXT,
      })
      .expect(200);

    const response = await as(harness, owner).get(
      `${base()}/spaces/${SLUG}/documents`,
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
