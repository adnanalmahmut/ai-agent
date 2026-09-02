import { Injectable } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../database';
import { AppException } from '../core/errors';
import { OutboxRepository } from '../core/outbox';
import {
  APPLICATION_MODEL_CATALOG,
  type AgentModelId,
} from '../model-catalog/model-catalog';
import { AgentConfigurationError } from './agent-configuration.error';
import { AgentDefinitionRegistry } from './agent-definition.registry';
import {
  AGENT_RUN_DRIVERS,
  MCP_SESSION_RUNTIME,
  TERMINAL_TRANSPORT_FAILURE,
  type AgentFailureDiagnostic,
  type AgentConfiguration,
  type AgentRun,
  type AgentRunStatus,
  type AgentValue,
  type CreateAgentRun,
} from './agent.types';

const AGENT_RUN_QUEUED = 'agent-run.queued';

/**
 * The advisory-lock namespace for agent-run acceptance.
 *
 * PostgreSQL's advisory locks share one global space, so an unrelated feature
 * taking `pg_advisory_xact_lock(hashtext(someId))` could block acceptance for
 * an organization whose id happened to hash to the same number. The two-integer
 * form partitions that space, and this constant is agent-run acceptance's
 * partition. Any other advisory lock in this application must pick a different
 * one; the value itself is arbitrary and only has to be distinct.
 */
export const AGENT_RUN_CAPACITY_LOCK = 4_310_001;

type PersistedAgentRun = Awaited<
  ReturnType<PrismaService['agentRun']['findUniqueOrThrow']>
>;

/** Where a reconciliation pass got to, so the next one resumes rather than restarts. */
export type StaleRunCursor = { updatedAt: Date; id: string };

/**
 * Only what a reconciliation decision needs.
 *
 * Deliberately not the whole row: `input` and `output` hold prompts and model
 * results, and `organizationId` and `createdByUserId` identify a tenant. None
 * of it informs the decision, so none of it is loaded into a process whose job
 * is to write log lines about these rows.
 */
export type StaleAgentRun = {
  id: string;
  status: AgentRunStatus;
  attemptCount: number;
  updatedAt: Date;
  /**
   * Needed to tell a stranded worker run from an abandoned MCP session, which
   * are reconciled by opposite means: one is asked about over the transport,
   * the other has no transport record by design and is finalized on age.
   */
  runtime: string;
  createdAt: Date;
  organizationId: string;
};

/** Internal acceptance boundary for durable background agent work. */
@Injectable()
export class AgentRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRepository,
    private readonly definitions: AgentDefinitionRegistry,
  ) {}

  /**
   * Commits the run and its queue intent together.
   *
   * Authorization is intentionally not performed here: this slice has no HTTP
   * operation. A future real-agent feature must authorize before calling this
   * internal service and must supply a registered definition/runtime pair.
   */
  async create(input: CreateAgentRun): Promise<AgentRun> {
    /**
     * An obvious retry is answered without taking a lock.
     *
     * Not the authoritative check — the same lookup is repeated inside the
     * transaction below, where it is serialized against concurrent accepts.
     * This one exists so the overwhelmingly common case, a client re-sending a
     * request whose response it never saw, does not queue behind every other
     * acceptance in the organization.
     */
    const existing = await this.findByIdempotencyKey(input);
    if (existing) return toAgentRun(existing);

    try {
      const run = await this.prisma.$transaction(async (tx) => {
        /**
         * The ceiling is exact, and this is what makes it exact.
         *
         * Counting in-flight runs and then inserting one is a
         * read-modify-write, and PostgreSQL's default isolation does not stop
         * two of them from interleaving: both transactions read the same count,
         * both see room, both commit, and an organization limited to one run
         * has two. Nothing about that is visible afterwards — the runs look
         * ordinary and the bill is simply larger than the operator set.
         *
         * The lock is a transaction-scoped advisory lock keyed on the
         * organization, so the count and the insert happen as one indivisible
         * decision per tenant. Transaction-scoped rather than session-scoped
         * because it is released by commit or rollback rather than by a call
         * this code has to remember to make — a lock leaked on an error path
         * would wedge every subsequent acceptance for that organization until
         * the connection was recycled.
         *
         * Two integers rather than one bigint: the first is a namespace
         * constant so this lock cannot collide with an unrelated one taken
         * elsewhere in the application, and the second is `hashtext` of the
         * organization id. Two organizations whose ids happen to hash alike
         * serialize against each other, which costs them a little latency and
         * costs correctness nothing — the invariant is per-organization and a
         * shared lock is stricter, never looser.
         *
         * Deliberately not a Redis semaphore. Redis is disposable coordination
         * in this system: a semaphore there would grant capacity that no longer
         * matched the durable rows the moment it was flushed, and reconciling
         * the two would be a second source of truth for how many runs exist.
         */
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AGENT_RUN_CAPACITY_LOCK}, hashtext(${input.organizationId}))`;

        /**
         * Repeated under the lock, and repeated *before* the capacity check.
         *
         * A caller retrying a request that timed out has already been accepted
         * and has already been paid for. Refusing their retry at a ceiling they
         * are themselves part of would strand a run they can no longer reach —
         * so an accepted key is answered with its run even when the
         * organization is at capacity.
         */
        const accepted = await tx.agentRun.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });

        if (accepted) return accepted;

        const effective = await this.resolveEffectiveVersion(tx, input);
        await assertCapacity(tx, input);
        const acceptedAt = new Date();
        const pricingRevision = APPLICATION_MODEL_CATALOG.pricingRevision(
          effective.modelId,
          acceptedAt,
        );

        /**
         * A session is accepted already running, and running is the truth:
         * the external MCP client can call a tool on its very next request,
         * so there is no queued interval to represent. `attemptCount` is 1
         * because a session has exactly one attempt — nothing retries it.
         */
        const session = input.driver === AGENT_RUN_DRIVERS.mcpClient;

        const created = await tx.agentRun.create({
          data: {
            agentId: input.agentId,
            agentVersion: effective.definitionVersion,
            runtime: session ? MCP_SESSION_RUNTIME : effective.runtime,
            organizationId: input.organizationId,
            organizationAgentVersionId: effective.id,
            modelPolicyId: effective.modelPolicyId,
            modelId: effective.modelId,
            modelPricingRevisionId: pricingRevision.id,
            createdByUserId: input.createdByUserId,
            input: input.input as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey,
            createdAt: acceptedAt,
            ...(session
              ? {
                  status: 'RUNNING' as const,
                  startedAt: acceptedAt,
                  attemptCount: 1,
                }
              : {}),
          },
        });

        /**
         * No event for a session, because there is no work to deliver.
         *
         * The run's "runtime" is a client this process does not control, and
         * publishing a job for it would create a delivery the worker must
         * refuse — `AgentRuntimeRegistry.resolve` cannot resolve
         * `MCP_SESSION_RUNTIME` — which is a failure recorded against a
         * healthy session.
         */
        if (!session) {
          await this.outbox.append(tx, {
            type: AGENT_RUN_QUEUED,
            payload: { runId: created.id },
            dedupeKey: created.id,
          });
        }

        return created;
      });

      return toAgentRun(run);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      const winner = await this.findByIdempotencyKey(input);

      // A P2002 on this insert can only be the durable idempotency constraint.
      // Still fail loudly if the winning row cannot be observed instead of
      // manufacturing a success response with no durable authority behind it.
      if (!winner) throw error;

      return toAgentRun(winner);
    }
  }

  /**
   * Atomically claims exactly the BullMQ attempt currently being delivered.
   *
   * The attempt counter stores BullMQ's active-start ordinal as the claim
   * version. A duplicate delivery can observe the same/newer version but cannot
   * claim it or execute the runtime again. Unlike attemptsMade, that ordinal
   * also advances when BullMQ recovers a stalled job after worker death.
   */
  async claimExecutionAttempt(
    runId: string,
    attemptsStarted: number,
  ): Promise<AgentRun | null> {
    if (!Number.isInteger(attemptsStarted) || attemptsStarted < 1) {
      throw new Error(
        'Agent execution attempt number must be a positive integer',
      );
    }

    // A worker may stall before it reaches this transaction. Any active
    // delivery can therefore be the first durable claim, and its BullMQ start
    // ordinal becomes the CAS version without inventing a lease system here.
    const queuedClaim = await this.prisma.agentRun.updateManyAndReturn({
      where: {
        id: runId,
        status: 'QUEUED',
        attemptCount: { lt: attemptsStarted },
      },
      data: {
        status: 'RUNNING',
        attemptCount: attemptsStarted,
        lastError: null,
        startedAt: new Date(),
      },
    });

    if (queuedClaim[0]) return toAgentRun(queuedClaim[0]);

    // Monotonic, not exact-predecessor. BullMQ increments `attemptsStarted`
    // inside Redis at move-to-active, before any of this process runs, so a
    // worker that is killed between activation and this statement consumes an
    // ordinal PostgreSQL never observes. The durable sequence is therefore
    // strictly increasing but may have gaps: after a claim at 1, the next
    // delivery to arrive here can legitimately be 3. Requiring
    // `attemptCount === attemptsStarted - 1` wedges exactly that run.
    //
    // `attemptsStarted` is unique per delivery and never decreases, which is
    // what makes it usable as a fencing token: a greater ordinal is a newer
    // delivery and may take ownership, an equal or lesser one is stale or
    // duplicate and must do nothing.
    const runningClaim = await this.prisma.agentRun.updateManyAndReturn({
      where: {
        id: runId,
        status: 'RUNNING',
        attemptCount: { lt: attemptsStarted },
      },
      data: {
        attemptCount: attemptsStarted,
        lastError: null,
      },
    });

    if (runningClaim[0]) return toAgentRun(runningClaim[0]);

    const current = await this.prisma.agentRun.findUnique({
      where: { id: runId },
    });

    if (!current) throw new Error(`AgentRun "${runId}" does not exist`);

    // Terminal runs are finished business truth; a late delivery cannot
    // reopen them. A stale or duplicate active start for a run already at or
    // beyond this ordinal is a safe no-op: the newer delivery owns the work.
    return null;
  }

  async markExecutionSucceeded(
    runId: string,
    attemptCount: number,
    output: AgentValue,
  ): Promise<boolean> {
    const { count } = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: 'RUNNING', attemptCount },
      data: {
        status: 'SUCCEEDED',
        // `== null` on purpose: Prisma treats an `undefined` field as "do not
        // update", so an SDK returning no output would record SUCCEEDED with a
        // silently missing result instead of an explicit JSON null.
        output:
          output == null ? Prisma.JsonNull : (output as Prisma.InputJsonValue),
        lastError: null,
        completedAt: new Date(),
      },
    });

    return count === 1;
  }

  async recordExecutionFailure(
    runId: string,
    attemptCount: number,
    lastError: AgentFailureDiagnostic,
    final: boolean,
  ): Promise<boolean> {
    const { count } = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: 'RUNNING', attemptCount },
      data: final
        ? {
            status: 'FAILED',
            lastError,
            completedAt: new Date(),
          }
        : { lastError },
    });

    return count === 1;
  }

  /**
   * A bounded page of runs that are not finished and have gone quiet.
   *
   * Ordered oldest-first so a backlog is examined in the order it accumulated,
   * and limited so one pass returns a fixed number of rows however large the
   * backlog is. (The number of rows is bounded; the cost of finding them is
   * not strictly — see the index note in `docs/database.md`.) `updatedAt`
   * rather than `startedAt`, because a run that never left `QUEUED` has no
   * `startedAt` and is precisely one of the cases that can be stranded.
   *
   * `after` is a keyset cursor, and it is what makes the sweep make progress
   * rather than merely make queries. A candidate the caller cannot act on is
   * left unwritten, so its `updatedAt` never moves and oldest-first would hand
   * back the same rows forever; once enough of them exist, no newer run is ever
   * examined again and the recovery mechanism silently stops recovering.
   * Paging past what has already been seen bounds each row's influence to one
   * visit per cycle.
   *
   * The staleness bound is a cost control and nothing more. Every candidate is
   * still checked against the transport before anything is written, so
   * including a run that turns out to be healthy is wasted work rather than a
   * wrong outcome.
   */
  findStaleNonTerminal(
    staleBefore: Date,
    limit: number,
    after?: StaleRunCursor,
  ): Promise<StaleAgentRun[]> {
    return this.prisma.agentRun.findMany({
      where: {
        status: { in: ['QUEUED', 'RUNNING'] },
        updatedAt: { lt: staleBefore },
        // `updatedAt` is not unique, so the cursor is the pair. Comparing on
        // the timestamp alone would skip every row sharing the last one's
        // millisecond.
        ...(after
          ? {
              OR: [
                { updatedAt: { gt: after.updatedAt } },
                { updatedAt: after.updatedAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        status: true,
        attemptCount: true,
        updatedAt: true,
        runtime: true,
        createdAt: true,
        organizationId: true,
      },
    });
  }

  /**
   * The one row an MCP request is allowed to act on.
   *
   * Predicated on the runtime as well as the tenant, so a worker run's id
   * cannot be presented as a session: an `AgentRun` that Mastra is executing
   * has grants pinned for *its* attempt, and driving it from outside would
   * write tool executions against a run whose transcript nobody is keeping.
   * Returns null rather than throwing, so the caller decides what a miss means
   * — and a miss is deliberately indistinguishable from another
   * organization's session.
   */
  findMcpSession(input: { id: string; organizationId: string }): Promise<{
    id: string;
    agentId: string;
    agentVersion: number;
    organizationAgentVersionId: string | null;
    organizationId: string;
    status: AgentRunStatus;
    createdByUserId: string | null;
    createdAt: Date;
  } | null> {
    return this.prisma.agentRun.findFirst({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        runtime: MCP_SESSION_RUNTIME,
      },
      select: {
        id: true,
        agentId: true,
        agentVersion: true,
        organizationAgentVersionId: true,
        organizationId: true,
        status: true,
        createdByUserId: true,
        createdAt: true,
      },
    });
  }

  /**
   * Ends a session, once.
   *
   * Compare-and-set on the tenant, the runtime and `RUNNING`, so an explicit
   * close by the client and an expiry observed elsewhere cannot both write an
   * outcome — the loser matches no row and reports false. That matters because
   * the two disagree about `closedBy`, and a session that recorded both would
   * be a row whose own history contradicts itself.
   *
   * `SUCCEEDED` rather than a new terminal status: a session that ran and
   * ended did not fail, whatever its tools did. What each tool call did is the
   * `ToolExecution` rows' business, and a session whose every call failed is
   * still a session that completed.
   */
  async closeMcpSession(input: {
    id: string;
    organizationId: string;
    closedBy: 'client' | 'expiry';
  }): Promise<boolean> {
    const closedAt = new Date();

    const { count } = await this.prisma.agentRun.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        runtime: MCP_SESSION_RUNTIME,
        status: 'RUNNING',
      },
      data: {
        status: 'SUCCEEDED',
        completedAt: closedAt,
        output: { closedBy: input.closedBy },
      },
    });

    return count === 1;
  }

  /**
   * Finalizes a run whose transport job has terminally failed.
   *
   * Deliberately not gated on `attemptCount`. The attempt fence exists so one
   * delivery cannot overwrite another delivery's outcome, and this caller is not
   * a delivery — it is the observation that the transport has stopped producing
   * deliveries at all. Gating it on an ordinal would mean guessing which
   * abandoned attempt to impersonate, and the guess would be wrong exactly in
   * the skipped-ordinal case the fence was introduced for.
   *
   * The status filter is what keeps it safe. `SUCCEEDED` and `FAILED` are
   * finished business truth and match nothing, so a duplicate, delayed, or
   * reordered observation is a no-op, and a run that a late worker managed to
   * complete is never dragged back to failed. A run that does not exist matches
   * nothing either, which is the correct answer rather than an error: the
   * transport can outlive the row it referred to.
   */
  async reconcileTerminalFailure(runId: string): Promise<boolean> {
    const { count } = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        lastError: TERMINAL_TRANSPORT_FAILURE,
        completedAt: new Date(),
      },
    });

    return count === 1;
  }

  /**
   * Reads one run, scoped to the organization that owns it.
   *
   * The organization is a predicate rather than a check on the result: a run
   * id from another tenant must be indistinguishable from one that does not
   * exist, and comparing after the read is how that distinction leaks back
   * out through a different error.
   */
  async findForOrganization(input: {
    runId: string;
    organizationId: string;
  }): Promise<AgentRun | null> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: input.runId, organizationId: input.organizationId },
    });

    return run === null ? null : toAgentRun(run);
  }

  /** Bounded product availability without exposing installation metadata. */
  async installationAvailability(input: {
    organizationId: string;
    agentId: string;
  }): Promise<'agent_not_installed' | 'agent_disabled' | null> {
    const installation =
      await this.prisma.organizationAgentInstallation.findUnique({
        where: {
          organizationId_agentId: {
            organizationId: input.organizationId,
            agentId: input.agentId,
          },
        },
        select: { activeVersion: { select: { enabled: true } } },
      });

    if (!installation?.activeVersion) return 'agent_not_installed';
    return installation.activeVersion.enabled ? null : 'agent_disabled';
  }

  /**
   * Reloads the immutable organization configuration named by the run.
   *
   * The queue carries only `runId`; every attempt asks PostgreSQL again. A null
   * result is the explicit legacy case and tells the runner to use the pinned
   * code definition's owned default, never today's installation pointer.
   */
  /**
   * The immutable organization version this run was accepted against.
   *
   * One verified read answering both questions a run needs of its pin: the
   * configuration it must execute with, and the tools it may call. They are
   * facts of the same row and the same tenant check, so reading them
   * separately would mean two places that could disagree about which version
   * is authoritative.
   *
   * Null for a legacy run created before organization-agent pinning existed.
   * Those have no configuration and, necessarily, no tools.
   */
  async pinnedVersionFor(
    run: Pick<
      AgentRun,
      | 'organizationAgentVersionId'
      | 'organizationId'
      | 'agentId'
      | 'agentVersion'
    >,
  ): Promise<{
    configuration: AgentConfiguration;
    toolGrants: readonly string[];
  } | null> {
    if (run.organizationAgentVersionId === null) return null;

    const version = await this.prisma.organizationAgentVersion.findFirst({
      where: {
        id: run.organizationAgentVersionId,
        organizationId: run.organizationId,
        definitionVersion: run.agentVersion,
        installation: {
          organizationId: run.organizationId,
          agentId: run.agentId,
        },
      },
      select: { configuration: true, toolGrants: true },
    });

    if (!version) {
      throw new AgentConfigurationError(
        'AgentRun organization version does not match its durable identity',
      );
    }

    return {
      configuration: version.configuration as AgentConfiguration,
      toolGrants: version.toolGrants,
    };
  }

  /** The effective installation snapshot selected inside run acceptance. */
  private async resolveEffectiveVersion(
    tx: Prisma.TransactionClient,
    input: CreateAgentRun,
  ): Promise<{
    id: string;
    definitionVersion: number;
    runtime: string;
    modelPolicyId: string;
    modelId: AgentModelId;
  }> {
    const installation = await tx.organizationAgentInstallation.findUnique({
      where: {
        organizationId_agentId: {
          organizationId: input.organizationId,
          agentId: input.agentId,
        },
      },
      select: {
        activeVersion: {
          select: {
            id: true,
            definitionVersion: true,
            enabled: true,
            configuration: true,
            modelPolicyId: true,
            modelId: true,
          },
        },
      },
    });

    const active = installation?.activeVersion;
    if (!active) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'organizationAgentInstallation' },
        publicDetails: { reason: 'agent_not_installed' },
      });
    }
    if (!active.enabled) {
      throw new AppException('FEATURE_DISABLED', {
        context: { resource: 'organizationAgentInstallation' },
        publicDetails: { reason: 'agent_disabled' },
      });
    }

    let definition;
    try {
      definition = this.definitions.resolve(
        input.agentId,
        active.definitionVersion,
      );
      this.definitions.parseOrganizationConfiguration(
        input.agentId,
        active.definitionVersion,
        active.configuration,
      );
    } catch (error) {
      if (error instanceof AgentConfigurationError) {
        throw new AppException('NOT_FOUND', {
          context: { resource: 'agentDefinition' },
          publicDetails: { reason: 'agent_definition_unavailable' },
        });
      }
      throw new AppException('CONFLICT', {
        context: { resource: 'organizationAgentConfiguration' },
        publicDetails: { reason: 'invalid_active_configuration' },
      });
    }

    const model = effectiveModelSelection(definition, active);

    return {
      id: active.id,
      definitionVersion: definition.version,
      runtime: definition.runtime,
      modelPolicyId: model.modelPolicyId,
      modelId: model.modelId,
    };
  }

  private findByIdempotencyKey(
    input: Pick<CreateAgentRun, 'organizationId' | 'idempotencyKey'>,
  ) {
    return this.prisma.agentRun.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
  }
}

/**
 * Refuses a new run when the organization is already at its ceiling.
 *
 * A free function taking the transaction client rather than a method, because
 * it is only ever correct inside the advisory lock above — a method on the
 * service reachable from `this.prisma` would be a version of this check with no
 * serialization behind it, sitting one autocomplete away from the version that
 * has some.
 *
 * `maxInFlight` absent means no ceiling, which is what internal callers with no
 * cost exposure want; the lock is still taken, which costs one round trip and
 * keeps the acceptance path uniform.
 */
async function assertCapacity(
  tx: Pick<PrismaService, 'agentRun'>,
  input: CreateAgentRun,
): Promise<void> {
  const { maxInFlight } = input;

  if (maxInFlight === undefined) return;

  const inFlight = await tx.agentRun.count({
    where: {
      organizationId: input.organizationId,
      status: { in: ['QUEUED', 'RUNNING'] },
    },
  });

  if (inFlight < maxInFlight) return;

  throw new AppException('TOO_MANY_REQUESTS', {
    context: { resource: 'agentRun', organizationId: input.organizationId },
    publicDetails: {
      reason:
        'This organization already has the maximum number of agent runs in flight. Wait for one to finish.',
    },
  });
}

function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Mapped field by field rather than spread. A spread is not excess-property
 * checked, so every column the Prisma model gains would silently become part
 * of the application-owned contract this module exists to keep separate.
 */
function toAgentRun(run: PersistedAgentRun): AgentRun {
  return {
    id: run.id,
    agentId: run.agentId,
    agentVersion: run.agentVersion,
    organizationAgentVersionId: run.organizationAgentVersionId,
    modelPolicyId: run.modelPolicyId,
    modelId: run.modelId as AgentModelId | null,
    modelPricingRevisionId: run.modelPricingRevisionId,
    runtime: run.runtime,
    status: run.status,
    organizationId: run.organizationId,
    createdByUserId: run.createdByUserId,
    input: run.input as AgentValue,
    output: run.output as AgentValue | null,
    lastError: run.lastError,
    attemptCount: run.attemptCount,
    idempotencyKey: run.idempotencyKey,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function effectiveModelSelection(
  definition: ReturnType<AgentDefinitionRegistry['resolve']>,
  version: { modelPolicyId: string | null; modelId: string | null },
): { modelPolicyId: string; modelId: AgentModelId } {
  if (version.modelPolicyId === null && version.modelId === null) {
    return {
      modelPolicyId: definition.modelPolicy.id,
      modelId: definition.model,
    };
  }
  if (version.modelPolicyId === null || version.modelId === null) {
    throw invalidActiveModelPolicy();
  }
  if (
    version.modelPolicyId !== definition.modelPolicy.id ||
    !definition.modelPolicy.allowedModelIds.includes(
      version.modelId as AgentModelId,
    )
  ) {
    throw invalidActiveModelPolicy();
  }
  try {
    APPLICATION_MODEL_CATALOG.agentModel(version.modelId);
  } catch {
    throw invalidActiveModelPolicy();
  }
  return {
    modelPolicyId: version.modelPolicyId,
    modelId: version.modelId as AgentModelId,
  };
}

function invalidActiveModelPolicy(): AppException {
  return new AppException('CONFLICT', {
    context: { resource: 'organizationAgentModelPolicy' },
    publicDetails: { reason: 'invalid_active_model_policy' },
  });
}
