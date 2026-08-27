import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import {
  AgentRunService,
  CONTENT_IDEA_AGENT_ID,
  contentIdeaInput,
  type AgentRun,
  type AgentValue,
  type ContentIdeaInput,
} from '../agents';
import { RuntimeConfigResolver } from '../control-plane';
import { AppException } from '../core/errors';

/**
 * Why generation is or is not available to this organization right now.
 *
 * A product answer, not a control-plane one. An ordinary member holds no
 * platform permission and must never be handed the operator API, so this says
 * exactly what the screen needs — whether the button will work, and which of
 * the two switches is off — and nothing about the rest of the platform's
 * configuration.
 *
 * `reason` names the coarse switch first when both are off, matching the order
 * acceptance checks them in, so the screen and the refusal agree.
 */
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

/**
 * What a caller is told about a request they made.
 *
 * `output` is present only once the run succeeded, and `failed` carries no
 * description at all. The run's `lastError` is one of two constants by
 * construction, and neither says anything a caller could act on — surfacing it
 * would suggest otherwise while still telling them nothing.
 */
export type ContentIdeaOperation = {
  id: string;
  status: AgentRun['status'];
  output: AgentValue | null;
  createdAt: Date;
  completedAt: Date | null;
};

/**
 * The business surface in front of the content-idea agent.
 *
 * Thin on purpose. Acceptance is already a solved problem — `AgentRunService`
 * commits the run and its queue intent in one transaction with a durable
 * idempotency key — so this adds the three things that are specific to being a
 * *product* feature rather than an internal capability: the feature gate, the
 * input contract, and binding the caller's idempotency key to the request it
 * was sent with.
 */
@Injectable()
export class ContentIdeaService {
  constructor(
    private readonly runs: AgentRunService,
    private readonly runtimeConfig: RuntimeConfigResolver,
  ) {}

  /**
   * Whether this organization may ask for ideas.
   *
   * Advisory, and the screen is told so: a flag can be switched off between
   * this read and the submission that follows it, and acceptance re-evaluates
   * both flags in the same order regardless of what this returned. That is the
   * point — this exists so the common case does not require an operator to
   * fill in a form and press a button to discover the feature is off, not so
   * the client can decide.
   *
   * Not gated on the flags it reports. A readiness check that refused to answer
   * when the answer was "no" would be unable to say the one thing it exists to
   * say.
   */
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
    /**
     * Both gates, coarse first.
     *
     * `agents.enabled` is the switch that stops every agent at once — the one
     * an operator reaches for when the provider is misbehaving or spend has to
     * stop now — and until this feature existed it gated nothing, because
     * nothing accepted agent work. Checking only `content_ideas.enabled` would
     * leave it that way: an operator could switch agents off, watch runs keep
     * being accepted, and have no way to know the real switch was the
     * per-feature one.
     *
     * Coarse before specific so the message names the broader cause when both
     * are off.
     */
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

    /**
     * The stored key binds the caller's key to the body it arrived with.
     *
     * `AgentRunService` returns the existing run for a key it has already
     * accepted and does not compare the rest of the request against it — which
     * is the correct behavior for a retry and the wrong one for reuse. Mixing
     * a digest of the request into the key makes the two distinguishable: an
     * honest retry sends the same body and finds its own run, while the same
     * key with a different body is a different key and gets the run it asked
     * for rather than somebody else's answer.
     */
    /**
     * The operator's in-flight ceiling, read here because this is where the
     * control plane is already resolved.
     *
     * `agents.max_concurrent_runs_per_organization` had been declared to
     * operators since the control plane landed and enforced by nothing, which
     * was harmless while no feature spent money through this path. This is
     * that feature. The per-user rate limit on the controller does not
     * substitute: it bounds one member, and the bill is the organization's.
     */
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

  /**
   * Reading is not gated on the feature flag.
   *
   * Turning content ideas off stops new requests; it does not retract answers
   * an organization already has. A screen that lost its results the moment an
   * operator disabled the feature would look like data loss.
   */
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

/**
 * The caller's key plus a digest of what they asked for.
 *
 * Sorted before hashing so a semantically identical retry that serialized its
 * keys in another order is still the same request.
 */
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
