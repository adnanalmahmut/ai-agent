import { Injectable } from '@nestjs/common';

import { RuntimeConfigResolver } from '../control-plane';
import { AppException } from '../core/errors';
import { PrismaService } from '../database';
import { isUniqueConstraintViolation } from './prisma-errors';

export type KnowledgeSpaceSummary = {
  id: string;
  slug: string;
  name: string;
  documentCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Spaces: the unit an agent's context policy names.
 *
 * A policy is written in code against a slug, so the slug is the stable
 * identifier and the uuid is an implementation detail. That is why the slug is
 * unique per organization and why it is not editable — renaming one would
 * silently take a space out of every policy that referenced it, with no error
 * anywhere.
 */
/** The most spaces a listing will return. */
const LIST_LIMIT = 200;

@Injectable()
export class KnowledgeSpaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeConfig: RuntimeConfigResolver,
  ) {}

  async list(organizationId: string): Promise<KnowledgeSpaceSummary[]> {
    const spaces = await this.prisma.knowledgeSpace.findMany({
      where: { organizationId },
      orderBy: { slug: 'asc' },
      /** A ceiling, for the reason given on the document listing. */
      take: LIST_LIMIT,
      select: {
        id: true,
        slug: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { documents: true } },
      },
    });

    return spaces.map(({ _count, ...space }) => ({
      ...space,
      documentCount: _count.documents,
    }));
  }

  /**
   * Creating a space is gated; reading is not.
   *
   * The flag's promise is that disabling a feature refuses *new* work. Hiding
   * material an organization already has would be a different and worse
   * promise — an operator switching the feature off to stop ingestion would
   * also be deleting the evidence of what had been ingested, from the point of
   * view of anyone looking at the screen.
   */
  async create(input: {
    organizationId: string;
    slug: string;
    name: string;
  }): Promise<KnowledgeSpaceSummary> {
    await this.runtimeConfig.assertFeature('knowledge.enabled', {
      organizationId: input.organizationId,
    });

    try {
      const space = await this.prisma.knowledgeSpace.create({
        data: {
          organizationId: input.organizationId,
          slug: input.slug,
          name: input.name,
        },
        select: {
          id: true,
          slug: true,
          name: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return { ...space, documentCount: 0 };
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      throw new AppException('CONFLICT', {
        context: { resource: 'knowledgeSpace', slug: input.slug },
      });
    }
  }

  /**
   * Removing a space removes its documents and their chunks, by cascade.
   *
   * Not a soft delete, and the asymmetry with organizations is deliberate: an
   * organization carries membership and billing history worth keeping, while a
   * knowledge space is a copy of source material that can be ingested again.
   * A tombstone would mean retrieval has to remember to exclude it forever,
   * which is one more place the scoping predicate could be forgotten.
   */
  /**
   * Deliberately not gated on `knowledge.enabled`.
   *
   * The flag refuses *new* work — ingestion and the provider spend behind it.
   * Removal is the opposite: an operator who has just turned the feature off
   * for an organization is the likeliest person to want its material gone, and
   * a kill switch that locks the data in place would be the wrong shape. The
   * permission check still applies, so this is not open — it is simply not
   * something the flag is for.
   */
  async remove(input: {
    organizationId: string;
    spaceId: string;
  }): Promise<{ id: string }> {
    // Scoped delete rather than a read-then-delete: one statement, and a space
    // belonging to another organization matches nothing.
    const removed = await this.prisma.knowledgeSpace.deleteMany({
      where: { id: input.spaceId, organizationId: input.organizationId },
    });

    if (removed.count === 0) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'knowledgeSpace' },
      });
    }

    return { id: input.spaceId };
  }

  /** Resolves a slug to an id within one organization, for a context policy. */
  async resolveSlugs(input: {
    organizationId: string;
    slugs: readonly string[];
  }): Promise<string[]> {
    if (input.slugs.length === 0) return [];

    const spaces = await this.prisma.knowledgeSpace.findMany({
      where: {
        organizationId: input.organizationId,
        slug: { in: [...input.slugs] },
      },
      select: { id: true },
    });

    return spaces.map((space) => space.id);
  }
}
