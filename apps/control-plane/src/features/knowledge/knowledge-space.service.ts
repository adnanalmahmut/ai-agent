import { Injectable } from '@nestjs/common';
import type { z } from 'zod';

import { RuntimeConfigResolver } from '../control-plane';
import { AppException } from '../../core/errors';
import { PrismaService } from '../../infrastructure/database';
import {
  clearedKnowledgeSpaceSchema,
  knowledgeSpaceSummarySchema,
} from './knowledge.contract';
import {
  KNOWLEDGE_SPACE_SLUGS,
  knowledgeSpaceDefinition,
  type KnowledgeSpaceSlug,
} from './knowledge-space.registry';

export type KnowledgeSpaceSummary = z.output<
  typeof knowledgeSpaceSummarySchema
>;

type ClearedKnowledgeSpace = z.output<typeof clearedKnowledgeSpaceSchema>;

@Injectable()
export class KnowledgeSpaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeConfig: RuntimeConfigResolver,
  ) {}

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

  async assertWritable(organizationId: string): Promise<void> {
    await this.runtimeConfig.assertFeature('knowledge.enabled', {
      organizationId,
    });
  }

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

  async remove(input: {
    organizationId: string;
    slug: KnowledgeSpaceSlug;
  }): Promise<ClearedKnowledgeSpace> {
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
