import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';

import { FeatureFlagService } from '../../../src/features/control-plane';
import { KNOWLEDGE_SPACE_SLUGS } from '../../../src/features/knowledge/knowledge-space.registry';
import { KNOWLEDGE_DOCUMENT_INGESTED } from '../../../src/features/knowledge/knowledge.events';
import { EMBEDDING_MODEL } from '../../../src/features/knowledge/adapters/openai-embedding.adapter';
import { KnowledgeController } from '../../../src/features/knowledge/knowledge.controller';
import {
  as,
  createHarness,
  createUser,
  errorBody,
  type Harness,
  type TestUser,
} from '../../support/auth-harness';

const CONTROL_PLANE_ACTOR = 'e2e-harness';

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

    await harness.app.get(FeatureFlagService).setPlatformOverride({
      key: 'knowledge.enabled',
      enabled: true,
      actorUserId: superAdmin.id,
    });
  });

  afterAll(async () => {
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
    await harness.prisma.knowledgeSpace.deleteMany({
      where: { organizationId: { in: [organizationId, otherOrganizationId] } },
    });
  });

  describe('authorization', () => {
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

        expect(response.status).toBe(404);
      }
    });

    it('refuses every route to a platform super administrator who is not a member', async () => {
      for (const route of routes()) {
        const response = await call(superAdmin, route);

        expect(response.status).toBe(404);
      }
    });

    it('tells a non-member nothing about an archived organization', async () => {
      await harness.prisma.organization.update({
        where: { id: organizationId },
        data: { archivedAt: new Date() },
      });

      try {
        const stranger = await as(harness, outsider).get(`${base()}/spaces`);

        expect(stranger.status).toBe(404);
        expect(errorBody(stranger).errorCode).toBe('NOT_FOUND');

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

  describe('listings are scoped to the organization in the path', () => {
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

      expect(spaces).toHaveLength(KNOWLEDGE_SPACE_SLUGS.length);
      expect(spaces.every((space) => space.documentCount === 0)).toBe(true);
      expect(spaces.every((space) => !space.configured)).toBe(true);
    });
  });

  describe('spaces', () => {
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

      const events = await harness.prisma.outboxEvent.count({
        where: {
          type: 'knowledge-document.ingested',
          payload: { path: ['documentId'], equals: document.id },
        },
      });
      expect(events).toBe(1);
    });

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

    it('sends the repair request without a deduplication key', async () => {
      const first = dataOf<DocumentBody>(
        (await ingest({ title: 'Policies', content: TEXT })).body,
      );

      await ingest({ title: 'Policies', content: TEXT });

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

      expect(corrected.updatedAt).toBe(stored.updatedAt.toISOString());
      expect(corrected.updatedAt).not.toBe(first.updatedAt);
      expect(new Date(corrected.updatedAt).getTime()).toBeGreaterThan(
        new Date(first.updatedAt).getTime(),
      );

      expect(stored.revision).toBe(1);
      expect(corrected.revision).toBe(1);
      expect(corrected.changed).toBe(false);
    });

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

  describe('document paging', () => {
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

        expect(requests).toBeLessThan(10);
      } while (cursor !== null);

      expect(seen).toEqual([...TITLES].sort());
      expect(new Set(seen).size).toBe(TITLES.length);
    });

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

    expect(JSON.stringify(response.body)).not.toContain('refund window');
  });

  it('is the controller the API composes', () => {
    expect(harness.app.get(KnowledgeController)).toBeInstanceOf(
      KnowledgeController,
    );
  });
});
