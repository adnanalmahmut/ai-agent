import { Injectable } from '@nestjs/common';

import { RuntimeConfigResolver } from '../control-plane';
import { AppException } from '../../core/errors';
import { PrismaService } from '../../infrastructure/database';
import {
  KNOWLEDGE_SPACE_SLUGS,
  knowledgeSpaceDefinition,
  type KnowledgeSpaceSlug,
} from './knowledge-space.registry';

/**
 * One space as the management surface sees it: the registry entry, plus
 * whatever this organization has actually stored in it.
 *
 * `configured` is false until something is ingested. A space is a row that gets
 * created on first use rather than eight rows written at sign-up, so the
 * listing describes the whole taxonomy while the database holds only the parts
 * in use — an organization that never writes a design system never has one.
 */
export type KnowledgeSpaceSummary = {
  slug: KnowledgeSpaceSlug;
  /** The application's own name for the space. Never caller-supplied. */
  name: string;
  description: string;
  configured: boolean;
  documentCount: number;
  createdAt: Date | null;
  updatedAt: Date | null;
};

/**
 * Spaces: the unit an agent's context policy names.
 *
 * The taxonomy is code-owned (`knowledge-space.registry.ts`), which is what
 * removes the whole class of bug this service used to be exposed to. There is
 * no create operation any more — a caller may *select* a registered space, and
 * `ensure` writes the row for it on first use — so an unknown slug cannot be
 * persisted through the application. The slug stays the stable identifier and
 * stays uneditable, because a policy is written against it in code and renaming
 * one would silently take a space out of every policy that named it.
 */
@Injectable()
export class KnowledgeSpaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeConfig: RuntimeConfigResolver,
  ) {}

  /**
   * The whole taxonomy, joined to what this organization has stored.
   *
   * Structurally bounded by the registry rather than by a row limit: there are
   * eight entries and there cannot be a ninth, so this listing has no cursor
   * and needs none. The old two-hundred-row ceiling described a surface where a
   * customer could invent spaces without limit, and that surface is gone.
   */
  async list(organizationId: string): Promise<KnowledgeSpaceSummary[]> {
    const rows = await this.prisma.knowledgeSpace.findMany({
      where: { organizationId },
      select: {
        slug: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { documents: true } },
      },
    });

    const stored = new Map(rows.map((row) => [row.slug, row]));

    return KNOWLEDGE_SPACE_SLUGS.map((slug) => {
      const definition = knowledgeSpaceDefinition(slug);
      const row = stored.get(slug);

      return {
        slug,
        name: definition.name,
        description: definition.description,
        configured: row !== undefined,
        documentCount: row?._count.documents ?? 0,
        createdAt: row?.createdAt ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  /**
   * Makes sure the row for a registered space exists, and returns its id.
   *
   * Gated on `knowledge.enabled` because it is the first half of ingestion: a
   * caller reaches it by submitting a document, and the flag's promise is that
   * disabling the feature refuses new work. Reading is not gated, for the
   * reason stated on `list` in the original design — hiding material an
   * organization already has would look like data loss to whoever is looking at
   * the screen.
   *
   * The name is written from the registry on both paths, so a rename in code
   * propagates to rows that already exist instead of leaving them disagreeing
   * with the taxonomy. It is not what the Platform renders; that is a
   * translation keyed on the slug.
   *
   * Takes an optional transaction client so ingestion can ensure the space and
   * write the document in one commit — a space that exists with no document
   * because the second half failed is a row nothing points at.
   */
  async ensure(input: {
    organizationId: string;
    slug: KnowledgeSpaceSlug;
    tx?: Pick<PrismaService, 'knowledgeSpace'>;
  }): Promise<{ id: string; slug: KnowledgeSpaceSlug }> {
    const client = input.tx ?? this.prisma;
    const { name } = knowledgeSpaceDefinition(input.slug);

    const space = await client.knowledgeSpace.upsert({
      where: {
        organizationId_slug: {
          organizationId: input.organizationId,
          slug: input.slug,
        },
      },
      create: {
        organizationId: input.organizationId,
        slug: input.slug,
        name,
      },
      update: { name },
      select: { id: true },
    });

    return { id: space.id, slug: input.slug };
  }

  /**
   * Gates a space write without creating anything.
   *
   * `ensure` is called from inside the ingestion transaction, and evaluating a
   * feature flag there would hold a transaction open across an unrelated query.
   * The gate is therefore its own call, made before the transaction opens.
   */
  async assertWritable(organizationId: string): Promise<void> {
    await this.runtimeConfig.assertFeature('knowledge.enabled', {
      organizationId,
    });
  }

  /** The row's id for a registered slug, or null when nothing is stored yet. */
  async findId(input: {
    organizationId: string;
    slug: KnowledgeSpaceSlug;
  }): Promise<string | null> {
    const space = await this.prisma.knowledgeSpace.findUnique({
      where: {
        organizationId_slug: {
          organizationId: input.organizationId,
          slug: input.slug,
        },
      },
      select: { id: true },
    });

    return space?.id ?? null;
  }

  /**
   * Empties a space: its documents and their chunks go with it, by cascade.
   *
   * The row itself goes too, which is not the same as removing the space from
   * the taxonomy — the space is a registry entry and still appears in the
   * listing, now with nothing in it. Not a soft delete, and the asymmetry with
   * organizations is deliberate: this is a copy of source material that can be
   * ingested again, while a tombstone would mean retrieval has to remember to
   * exclude it forever.
   *
   * Deliberately not gated on `knowledge.enabled`. The flag refuses new work;
   * an operator who has just turned the feature off is the likeliest person to
   * want the material gone, and a kill switch that locks data in place would be
   * the wrong shape.
   */
  async remove(input: {
    organizationId: string;
    slug: KnowledgeSpaceSlug;
  }): Promise<{ slug: KnowledgeSpaceSlug }> {
    // Scoped delete rather than a read-then-delete: one statement, and a space
    // belonging to another organization matches nothing.
    const removed = await this.prisma.knowledgeSpace.deleteMany({
      where: { organizationId: input.organizationId, slug: input.slug },
    });

    if (removed.count === 0) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'knowledgeSpace' },
      });
    }

    return { slug: input.slug };
  }

  /**
   * Resolves policy slugs to ids within one organization.
   *
   * The organization is a predicate, not a filter applied afterwards: slugs are
   * only unique inside an organization, so a policy naming one must resolve
   * against the caller's own tenant or not at all.
   *
   * Returns the slug alongside the id because the caller labels each retrieved
   * passage with the space it came from, and the ids coming back out of
   * retrieval carry no name.
   */
  async resolveSlugs(input: {
    organizationId: string;
    slugs: readonly KnowledgeSpaceSlug[];
  }): Promise<{ id: string; slug: string }[]> {
    if (input.slugs.length === 0) return [];

    return this.prisma.knowledgeSpace.findMany({
      where: {
        organizationId: input.organizationId,
        slug: { in: [...input.slugs] },
      },
      select: { id: true, slug: true },
    });
  }
}
