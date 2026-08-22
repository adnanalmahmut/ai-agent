import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';

import { AgentRunService, type CreateAgentRun } from '../../src/agents';
import { OUTBOX_EVENT_ROUTES, OutboxRepository } from '../../src/core/outbox';
import type {
  NewOutboxEvent,
  OutboxWriter,
} from '../../src/core/outbox/outbox.repository';
import { QUEUE_NAMES } from '../../src/core/queue';
import { PrismaService } from '../../src/database';

const fixtureId = `agent-run-e2e-${process.pid}`;
const userId = `${fixtureId}-user`;
const organizationIds = [`${fixtureId}-org-a`, `${fixtureId}-org-b`] as const;

/**
 * Writes through the real transaction client before failing. If both writes are
 * truly in the same transaction, the preceding outbox insert and the AgentRun
 * insert are rolled back together.
 */
class AppendThenFailOutboxRepository extends OutboxRepository {
  attemptedDedupeKey: string | undefined;

  override async append(
    client: OutboxWriter,
    event: NewOutboxEvent,
  ): Promise<void> {
    this.attemptedDedupeKey = event.dedupeKey;
    await super.append(client, event);
    throw new Error('forced outbox append failure');
  }
}

describe('AgentRun foundation (e2e)', () => {
  let prisma: PrismaService;
  let service: AgentRunService;

  const cleanRuns = async () => {
    const runs = await prisma.agentRun.findMany({
      where: { organizationId: { in: [...organizationIds] } },
      select: { id: true },
    });
    const runIds = runs.map(({ id }) => id);

    if (runIds.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: { dedupeKey: { in: runIds } },
      });
    }

    await prisma.agentRun.deleteMany({
      where: { organizationId: { in: [...organizationIds] } },
    });
  };

  const request = (
    idempotencyKey: string,
    organizationId: string = organizationIds[0],
    overrides: Partial<CreateAgentRun> = {},
  ): CreateAgentRun => ({
    agentId: 'test-only-agent',
    agentVersion: 1,
    runtime: 'test-only-runtime',
    organizationId,
    createdByUserId: userId,
    input: { prompt: 'deterministic test input' },
    idempotencyKey,
    ...overrides,
  });

  beforeAll(async () => {
    prisma = new PrismaService({
      url: process.env.DATABASE_URL ?? '',
      connectTimeoutMs: 5_000,
    });
    await prisma.onModuleInit();

    // Remove only this suite's known fixture identities after an interrupted
    // prior run; no broad table cleanup is needed.
    await cleanRuns();
    await prisma.organization.deleteMany({
      where: { id: { in: [...organizationIds] } },
    });
    await prisma.user.deleteMany({ where: { id: userId } });

    await prisma.user.create({
      data: {
        id: userId,
        name: 'Agent Run E2E User',
        email: `${fixtureId}@example.test`,
      },
    });
    await prisma.organization.createMany({
      data: organizationIds.map((id, index) => ({
        id,
        name: `Agent Run E2E Organization ${index + 1}`,
        slug: `${fixtureId}-org-${index + 1}`,
      })),
    });

    service = new AgentRunService(prisma, new OutboxRepository(prisma));
  }, 60_000);

  afterEach(async () => {
    await cleanRuns();
  });

  afterAll(async () => {
    await cleanRuns();
    await prisma.organization.deleteMany({
      where: { id: { in: [...organizationIds] } },
    });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.onModuleDestroy();
  });

  it('commits one queued AgentRun and its routed outbox event atomically', async () => {
    const result = await service.create(request('committed-request'));

    const persisted = await prisma.agentRun.findUniqueOrThrow({
      where: { id: result.id },
    });
    const events = await prisma.outboxEvent.findMany({
      where: { dedupeKey: result.id },
    });

    expect(persisted).toMatchObject({
      id: result.id,
      agentId: 'test-only-agent',
      agentVersion: 1,
      status: 'QUEUED',
      organizationId: organizationIds[0],
      createdByUserId: userId,
      idempotencyKey: 'committed-request',
      attemptCount: 0,
    });
    expect(result.agentVersion).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent-run.queued',
      payload: { runId: result.id },
      dedupeKey: result.id,
      status: 'PENDING',
    });
    expect(OUTBOX_EVENT_ROUTES['agent-run.queued']).toEqual({
      queue: QUEUE_NAMES.agentExecution,
      jobName: 'execute',
    });
  });

  it('rolls back both the AgentRun and outbox event when append fails', async () => {
    const failingOutbox = new AppendThenFailOutboxRepository(prisma);
    const failingService = new AgentRunService(prisma, failingOutbox);

    await expect(
      failingService.create(request('rolled-back-request')),
    ).rejects.toThrow('forced outbox append failure');

    expect(failingOutbox.attemptedDedupeKey).toBeDefined();
    await expect(
      prisma.agentRun.findUnique({
        where: {
          organizationId_idempotencyKey: {
            organizationId: organizationIds[0],
            idempotencyKey: 'rolled-back-request',
          },
        },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.outboxEvent.findMany({
        where: { dedupeKey: failingOutbox.attemptedDedupeKey },
      }),
    ).resolves.toEqual([]);
  });

  it('returns one logical run for concurrent same-organization retries', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.create(request('concurrent-request')),
      ),
    );
    const runIds = new Set(results.map(({ id }) => id));

    expect(runIds.size).toBe(1);

    const runs = await prisma.agentRun.findMany({
      where: {
        organizationId: organizationIds[0],
        idempotencyKey: 'concurrent-request',
      },
    });
    const events = await prisma.outboxEvent.findMany({
      where: { dedupeKey: results[0]?.id },
    });

    expect(runs).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ runId: results[0]?.id });
  });

  it('returns the same run for a sequential retry without re-queueing it', async () => {
    // The concurrent case above only ever exercises the P2002 branch, because
    // all six requests get past the pre-check before anyone commits. This is
    // the ordinary client retry — the first request already committed — and it
    // is the path that must not append a second queue intent.
    const first = await service.create(request('sequential-retry'));
    const second = await service.create(request('sequential-retry'));

    expect(second.id).toBe(first.id);
    await expect(
      prisma.agentRun.count({
        where: {
          organizationId: organizationIds[0],
          idempotencyKey: 'sequential-retry',
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.outboxEvent.count({ where: { dedupeKey: first.id } }),
    ).resolves.toBe(1);
  });

  it('pins the accepted run to the requested definition version', async () => {
    // Two runs of the same agent at different revisions must stay
    // independently resolvable; acceptance is what fixes the version.
    const [first, second] = await Promise.all([
      service.create(request('pinned-v1', organizationIds[0])),
      service.create(
        request('pinned-v2', organizationIds[0], { agentVersion: 2 }),
      ),
    ]);

    await expect(
      prisma.agentRun.findUniqueOrThrow({ where: { id: first.id } }),
    ).resolves.toMatchObject({ agentId: 'test-only-agent', agentVersion: 1 });
    await expect(
      prisma.agentRun.findUniqueOrThrow({ where: { id: second.id } }),
    ).resolves.toMatchObject({ agentId: 'test-only-agent', agentVersion: 2 });
  });

  it('accepts a run with no authenticated initiating user', async () => {
    const result = await service.create(
      request('system-initiated-request', organizationIds[0], {
        createdByUserId: null,
      }),
    );

    expect(result.createdByUserId).toBeNull();

    const persisted = await prisma.agentRun.findUniqueOrThrow({
      where: { id: result.id },
      include: { createdByUser: true },
    });

    expect(persisted.createdByUserId).toBeNull();
    expect(persisted.createdByUser).toBeNull();

    // A creator-less run is still fully durable work: it commits its queue
    // intent exactly like a user-initiated one.
    await expect(
      prisma.outboxEvent.count({ where: { dedupeKey: result.id } }),
    ).resolves.toBe(1);
  });

  it('preserves the User relation for a user-initiated run', async () => {
    const result = await service.create(request('user-initiated-request'));

    const persisted = await prisma.agentRun.findUniqueOrThrow({
      where: { id: result.id },
      include: { createdByUser: true },
    });

    expect(persisted.createdByUserId).toBe(userId);
    expect(persisted.createdByUser).toMatchObject({ id: userId });

    // The relation is a real restricted foreign key, not a loose string.
    await expect(
      prisma.agentRun.create({
        data: {
          agentId: 'test-only-agent',
          agentVersion: 1,
          runtime: 'test-only-runtime',
          organizationId: organizationIds[0],
          createdByUserId: `${fixtureId}-absent-user`,
          input: {},
          idempotencyKey: 'dangling-creator-request',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('allows different organizations to reuse an idempotency key', async () => {
    const [first, second] = await Promise.all(
      organizationIds.map((organizationId) =>
        service.create(request('shared-request', organizationId)),
      ),
    );

    expect(first.id).not.toBe(second.id);
    await expect(
      prisma.agentRun.count({
        where: {
          organizationId: { in: [...organizationIds] },
          idempotencyKey: 'shared-request',
        },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.outboxEvent.count({
        where: { dedupeKey: { in: [first.id, second.id] } },
      }),
    ).resolves.toBe(2);
  });

  it('allows only one delivery to claim the same execution attempt', async () => {
    const accepted = await service.create(request('concurrent-claim'));

    const claims = await Promise.all([
      service.claimExecutionAttempt(accepted.id, 1),
      service.claimExecutionAttempt(accepted.id, 1),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(
      prisma.agentRun.findUniqueOrThrow({ where: { id: accepted.id } }),
    ).resolves.toMatchObject({ status: 'RUNNING', attemptCount: 1 });
  });

  it('makes terminal duplicate delivery a durable no-op', async () => {
    const accepted = await service.create(request('terminal-duplicate'));
    await prisma.agentRun.update({
      where: { id: accepted.id },
      data: {
        status: 'SUCCEEDED',
        output: { answer: 'already recorded' },
        completedAt: new Date(),
      },
    });

    await expect(
      service.claimExecutionAttempt(accepted.id, 1),
    ).resolves.toBeNull();
    await expect(
      prisma.agentRun.findUniqueOrThrow({ where: { id: accepted.id } }),
    ).resolves.toMatchObject({
      status: 'SUCCEEDED',
      attemptCount: 0,
      output: { answer: 'already recorded' },
    });
  });

  it('records successful output only for the active durable claim', async () => {
    const accepted = await service.create(request('successful-attempt'));
    const claimed = await service.claimExecutionAttempt(accepted.id, 1);

    expect(claimed).toMatchObject({ status: 'RUNNING', attemptCount: 1 });
    await expect(
      service.markExecutionSucceeded(accepted.id, 1, { answer: 'done' }),
    ).resolves.toBe(true);
    await expect(
      prisma.agentRun.findUniqueOrThrow({ where: { id: accepted.id } }),
    ).resolves.toMatchObject({
      status: 'SUCCEEDED',
      attemptCount: 1,
      output: { answer: 'done' },
      lastError: null,
      completedAt: expect.any(Date),
    });
  });

  it('keeps an intermediate failure retryable and permits a successful retry', async () => {
    const accepted = await service.create(request('successful-retry'));
    await service.claimExecutionAttempt(accepted.id, 1);

    await expect(
      service.recordExecutionFailure(
        accepted.id,
        1,
        'Agent execution failed',
        false,
      ),
    ).resolves.toBe(true);
    await expect(
      service.claimExecutionAttempt(accepted.id, 2),
    ).resolves.toMatchObject({ status: 'RUNNING', attemptCount: 2 });
    await expect(
      service.markExecutionSucceeded(accepted.id, 2, 'retry output'),
    ).resolves.toBe(true);

    await expect(
      prisma.agentRun.findUniqueOrThrow({ where: { id: accepted.id } }),
    ).resolves.toMatchObject({
      status: 'SUCCEEDED',
      attemptCount: 2,
      output: 'retry output',
      lastError: null,
    });
  });

  it('records FAILED only when the caller classifies the attempt as final', async () => {
    const accepted = await service.create(request('final-failure'));
    await service.claimExecutionAttempt(accepted.id, 1);

    await expect(
      service.recordExecutionFailure(
        accepted.id,
        1,
        'Agent execution failed',
        true,
      ),
    ).resolves.toBe(true);
    await expect(
      prisma.agentRun.findUniqueOrThrow({ where: { id: accepted.id } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      attemptCount: 1,
      lastError: 'Agent execution failed',
      completedAt: expect.any(Date),
    });
  });

  it('reclaims a stalled delivery after the prior worker durably claimed it', async () => {
    const accepted = await service.create(request('stall-after-claim'));
    await service.claimExecutionAttempt(accepted.id, 1);

    await expect(
      service.claimExecutionAttempt(accepted.id, 2),
    ).resolves.toMatchObject({ status: 'RUNNING', attemptCount: 2 });
  });

  it('claims a later active start when an earlier worker stalled before the database', async () => {
    const accepted = await service.create(request('stall-before-claim'));

    await expect(
      service.claimExecutionAttempt(accepted.id, 2),
    ).resolves.toMatchObject({ status: 'RUNNING', attemptCount: 2 });
    await service.recordExecutionFailure(
      accepted.id,
      2,
      'Agent execution failed',
      false,
    );
    await expect(
      service.claimExecutionAttempt(accepted.id, 3),
    ).resolves.toMatchObject({ status: 'RUNNING', attemptCount: 3 });
  });
});
