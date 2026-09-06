import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/database';
import { AgentDefinitionRegistry } from '../agents/agent-definition.registry';
import type { AgentDefinition } from '../agents/agent.types';
import { digestValue } from './digest';
import type { SideEffectExecutionRow } from './tool-execution.service';
import { TOOL_IMPLEMENTATIONS } from './tool.gateway';
import { ToolRegistry } from './tool.registry';
import {
  isSideEffectImplementation,
  isToolRef,
  type AnyToolImplementation,
  type SideEffectToolImplementation,
  type ToolFailureCode,
  type ToolRef,
} from './tool.types';

/**
 * What authorization hands back: the adapter that may run, and the pinned
 * definition it runs under. A caller cannot reach either without asking, which
 * is what stops a delivery path from assembling its own authority.
 */
export type AuthorizedToolEffect = {
  readonly ref: ToolRef;
  readonly implementation: SideEffectToolImplementation;
  readonly definition: AgentDefinition;
};

export type ToolAuthorizationRefusal = { readonly refusal: ToolFailureCode };

export function isToolAuthorizationRefusal(
  result: AuthorizedToolEffect | ToolAuthorizationRefusal,
): result is ToolAuthorizationRefusal {
  return 'refusal' in result;
}

/**
 * Whether an approved side effect may still be performed, asked immediately
 * before it would be.
 *
 * An approval is a statement about a moment. Between then and delivery an
 * organization can be archived, a grant withdrawn, a version replaced, or the
 * payload the approver saw replaced by another. Every one of those is checked
 * here against durable state, never against anything the caller supplied.
 */
@Injectable()
export class ToolAuthorizationService {
  private readonly implementations: ReadonlyMap<
    ToolRef,
    SideEffectToolImplementation
  >;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ToolRegistry,
    private readonly definitions: AgentDefinitionRegistry,
    @Inject(TOOL_IMPLEMENTATIONS)
    implementations: readonly AnyToolImplementation[],
  ) {
    const indexed = new Map<ToolRef, SideEffectToolImplementation>();

    for (const implementation of implementations) {
      if (isSideEffectImplementation(implementation)) {
        indexed.set(implementation.ref, implementation);
      }
    }

    this.implementations = indexed;
  }

  async authorize(
    row: SideEffectExecutionRow,
  ): Promise<AuthorizedToolEffect | ToolAuthorizationRefusal> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: row.organizationId },
      select: { archivedAt: true },
    });

    if (!organization || organization.archivedAt !== null) {
      return { refusal: 'precondition_organization' };
    }

    if (
      !row.approval ||
      row.approval.status !== 'APPROVED' ||
      row.approval.inputDigest !== digestValue(row.input)
    ) {
      return { refusal: 'precondition_approval' };
    }

    const ref = `${row.toolId}@${row.toolVersion}`;

    if (
      !isToolRef(ref) ||
      !this.registry.has(ref) ||
      this.registry.resolve(ref).risk !== 'side_effect'
    ) {
      return { refusal: 'precondition_authority' };
    }

    const implementation = this.implementations.get(ref);

    if (!implementation) return { refusal: 'precondition_authority' };

    let definition: AgentDefinition;

    try {
      definition = this.definitions.resolve(
        row.agentRun.agentId,
        row.agentRun.agentVersion,
      );
    } catch {
      return { refusal: 'precondition_authority' };
    }

    if (!(definition.maxToolGrants ?? []).includes(ref)) {
      return { refusal: 'precondition_authority' };
    }

    if (row.agentRun.organizationAgentVersionId === null) {
      return { refusal: 'precondition_authority' };
    }

    const version = await this.prisma.organizationAgentVersion.findFirst({
      where: {
        id: row.agentRun.organizationAgentVersionId,
        organizationId: row.organizationId,
        definitionVersion: row.agentRun.agentVersion,
        installation: {
          organizationId: row.organizationId,
          agentId: row.agentRun.agentId,
        },
      },
      select: { toolGrants: true },
    });

    if (!version || !version.toolGrants.includes(ref)) {
      return { refusal: 'precondition_authority' };
    }

    return { ref, implementation, definition };
  }
}
