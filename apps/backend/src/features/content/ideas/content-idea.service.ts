import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { AgentRun, AgentValue } from '../../../ai/agents/agent.types';
import { AgentRunService } from '../../../ai/execution/agent-run.service';
import {
  CONTENT_IDEA_AGENT_ID,
  contentIdeaInput,
  type ContentIdeaInput,
} from './agent-definitions';
import { RuntimeConfigResolver } from '../../control-plane';
import { AppException } from '../../../core/errors';

export const CONTENT_IDEA_UNAVAILABLE_REASONS = [
  'agents_disabled',
  'content_ideas_disabled',
  'agent_not_installed',
  'agent_disabled',
] as const;

export type ContentIdeaUnavailableReason =
  (typeof CONTENT_IDEA_UNAVAILABLE_REASONS)[number];

export type ContentIdeaAvailability = {
  available: boolean;
  reason: ContentIdeaUnavailableReason | null;
};

export type ContentIdeaOperation = {
  id: string;
  status: AgentRun['status'];
  output: AgentValue | null;
  createdAt: Date;
  completedAt: Date | null;
};

@Injectable()
export class ContentIdeaService {
  constructor(
    private readonly runs: AgentRunService,
    private readonly runtimeConfig: RuntimeConfigResolver,
  ) {}

  async availability(input: {
    organizationId: string;
  }): Promise<ContentIdeaAvailability> {
    const scope = { organizationId: input.organizationId };

    if (!(await this.runtimeConfig.isFeatureEnabled('agents.enabled', scope))) {
      return { available: false, reason: 'agents_disabled' };
    }

    if (
      !(await this.runtimeConfig.isFeatureEnabled(
        'content_ideas.enabled',
        scope,
      ))
    ) {
      return { available: false, reason: 'content_ideas_disabled' };
    }

    const installation = await this.runs.installationAvailability({
      organizationId: input.organizationId,
      agentId: CONTENT_IDEA_AGENT_ID,
    });
    if (installation !== null) {
      return { available: false, reason: installation };
    }

    return { available: true, reason: null };
  }

  async request(input: {
    organizationId: string;
    actorUserId: string;
    idempotencyKey: string;
    payload: unknown;
  }): Promise<ContentIdeaOperation> {
    await this.runtimeConfig.assertFeature('agents.enabled', {
      organizationId: input.organizationId,
    });

    await this.runtimeConfig.assertFeature('content_ideas.enabled', {
      organizationId: input.organizationId,
    });

    const parsed = contentIdeaInput.safeParse(input.payload);

    if (!parsed.success) {
      throw new AppException('VALIDATION_ERROR', {
        context: { resource: 'contentIdea' },
        publicDetails: {
          issues: parsed.error.issues.map((issue) => issue.message),
        },
      });
    }

    const maxInFlight = await this.runtimeConfig.setting(
      'agents.max_concurrent_runs_per_organization',
    );

    const run = await this.runs.create({
      maxInFlight,
      agentId: CONTENT_IDEA_AGENT_ID,
      organizationId: input.organizationId,
      createdByUserId: input.actorUserId,
      input: parsed.data,
      idempotencyKey: operationKey(input.idempotencyKey, parsed.data),
    });

    return toOperation(run);
  }

  async operation(input: {
    organizationId: string;
    runId: string;
  }): Promise<ContentIdeaOperation> {
    const run = await this.runs.findForOrganization(input);

    // Also the answer for a run belonging to another organization, and for one
    // produced by a different agent: none of the three is a distinction a
    // caller is entitled to.
    if (run === null || run.agentId !== CONTENT_IDEA_AGENT_ID) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'contentIdeaOperation' },
      });
    }

    return toOperation(run);
  }
}

function toOperation(run: AgentRun): ContentIdeaOperation {
  return {
    id: run.id,
    status: run.status,
    output: run.status === 'SUCCEEDED' ? run.output : null,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
  };
}

function operationKey(callerKey: string, payload: ContentIdeaInput): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(sortValue(payload)), 'utf8')
    .digest('hex')
    .slice(0, 32);

  return `content-idea:${callerKey}:${digest}`;
}

function sortValue(value: AgentValue): AgentValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
}
