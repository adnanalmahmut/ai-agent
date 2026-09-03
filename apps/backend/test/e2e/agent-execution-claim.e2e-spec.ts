import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';

import { AgentRunService, type CreateAgentRun } from '../../src/agents';
import { OutboxRepository } from '../../src/infrastructure/outbox';
import { PrismaService } from '../../src/infrastructure/database';
import {
  cleanTestAgentInstallations,
  installTestAgent,
  TEST_AGENT_ID,
  testAgentRegistry,
} from '../support/agent-run-fixtures';

const fixtureId = `agent-claim-e2e-${process.pid}`;
const organizationId = `${fixtureId}-org`;

/**
 * Durable attempt-claim semantics.
 *
 * BullMQ increments `attemptsStarted` inside Redis when it moves a job to
 * active, before any application code runs. A worker killed between that
 * increment and its first PostgreSQL write consumes an ordinal the database
 * never observes, so the durable sequence is strictly increasing but may have
 * gaps. These cases pin that behavior down against the real database rather
 * than a mock, because the predicate under test is a SQL WHERE clause.
 */
describe('AgentRun execution claim (e2e)', () => {
  let prisma: PrismaService;
  let service: AgentRunService;

  const request = (idempotencyKey: string): CreateAgentRun => ({
    agentId: TEST_AGENT_ID,
    organizationId,
    createdByUserId: null,
    input: { prompt: 'deterministic test input' },
    idempotencyKey,
  });

  const cleanRuns = async () => {
    const runs = await prisma.agentRun.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const runIds = runs.map(({ id }) => id);

    if (runIds.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: { dedupeKey: { in: runIds } },
      });
    }

    await prisma.agentRun.deleteMany({ where: { organizationId } });
  };

  beforeAll(async () => {
    prisma = new PrismaService({
      url: process.env.DATABASE_URL ?? '',
      connectTimeoutMs: 5_000,
    });
    await prisma.onModuleInit();

    await cleanRuns();
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Agent Claim E2E Organization',
        slug: `${fixtureId}-org`,
      },
    });
    await installTestAgent(prisma, organizationId);

    service = new AgentRunService(
      prisma,
      new OutboxRepository(prisma),
      testAgentRegistry(),
    );
  }, 60_000);

  afterEach(async () => {
    await cleanRuns();
  });

  afterAll(async () => {
    await cleanRuns();
    await cleanTestAgentInstallations(prisma, [organizationId]);
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.onModuleDestroy();
  });

  const statusOf = (runId: string) =>
    prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });

  it('claims a later active start after an earlier one stalled before PostgreSQL', async () => {
    const accepted = await service.create(request('skipped-ordinal-request'));

    // 1. Active start #1 reaches PostgreSQL and claims the run.
    const first = await service.claimExecutionAttempt(accepted.id, 1);
    expect(first).not.toBeNull();
    expect(first?.attemptCount).toBe(1);
    expect(first?.status).toBe('RUNNING');

    // 2. That attempt fails without exhausting BullMQ's retries.
    await expect(
      service.recordExecutionFailure(
        accepted.id,
        1,
        'Agent execution failed',
        false,
      ),
    ).resolves.toBe(true);
    await expect(statusOf(accepted.id)).resolves.toMatchObject({
      status: 'RUNNING',
      attemptCount: 1,
    });

    // 3. Active start #2 happens in Redis but the worker stalls or dies before
    //    reaching claimExecutionAttempt. Ordinal 2 is therefore never durably
    //    claimed — modelled precisely by making no call for it at all.

    // 4. Active start #3 reaches PostgreSQL. It MUST be able to claim.
    const third = await service.claimExecutionAttempt(accepted.id, 3);

    expect(third).not.toBeNull();
    expect(third?.attemptCount).toBe(3);
    expect(third?.status).toBe('RUNNING');
    await expect(statusOf(accepted.id)).resolves.toMatchObject({
      status: 'RUNNING',
      attemptCount: 3,
      // A fresh claim clears the previous attempt's diagnostic.
      lastError: null,
    });
  });

  it('proves the exact-predecessor predicate is what wedged the run', async () => {
    const accepted = await service.create(request('predecessor-regression'));
    await service.claimExecutionAttempt(accepted.id, 1);

    // The superseded implementation required attemptCount === attemptsStarted - 1.
    // Replayed against the same durable state that the case above recovers
    // from, it matches nothing and the run can never progress again.
    const { count: exactPredecessorMatches } = await prisma.agentRun.updateMany(
      {
        where: { id: accepted.id, status: 'RUNNING', attemptCount: 3 - 1 },
        data: { attemptCount: 3 },
      },
    );

    expect(exactPredecessorMatches).toBe(0);

    // The monotonic predicate accepts the same delivery.
    await expect(
      service.claimExecutionAttempt(accepted.id, 3),
    ).resolves.toMatchObject({ attemptCount: 3 });
  });

  it('treats an equal or older active start as a safe no-op', async () => {
    const accepted = await service.create(request('stale-delivery-request'));
    await service.claimExecutionAttempt(accepted.id, 1);
    await service.claimExecutionAttempt(accepted.id, 3);

    // The stalled ordinal 2 arrives late, and ordinal 3 is redelivered.
    await expect(
      service.claimExecutionAttempt(accepted.id, 2),
    ).resolves.toBeNull();
    await expect(
      service.claimExecutionAttempt(accepted.id, 3),
    ).resolves.toBeNull();

    await expect(statusOf(accepted.id)).resolves.toMatchObject({
      status: 'RUNNING',
      attemptCount: 3,
    });
  });

  it('lets the first durable claim start at any ordinal', async () => {
    const accepted = await service.create(request('late-first-claim-request'));

    // An earlier start died before PostgreSQL, so the run is still QUEUED and
    // the first durable claim arrives at an ordinal above 1. The 3 is an
    // arbitrary bound on the predicate, not a claim about how many consecutive
    // stalls BullMQ would actually allow — `maxStalledCount` defaults to 1.
    const claimed = await service.claimExecutionAttempt(accepted.id, 3);

    expect(claimed).toMatchObject({ status: 'RUNNING', attemptCount: 3 });
    expect(claimed?.startedAt).toBeInstanceOf(Date);
  });

  it('refuses to reopen a terminal run', async () => {
    const succeeded = await service.create(request('succeeded-request'));
    await service.claimExecutionAttempt(succeeded.id, 1);
    await service.markExecutionSucceeded(succeeded.id, 1, { answer: 'done' });

    await expect(
      service.claimExecutionAttempt(succeeded.id, 2),
    ).resolves.toBeNull();
    await expect(statusOf(succeeded.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      attemptCount: 1,
    });

    const failed = await service.create(request('failed-request'));
    await service.claimExecutionAttempt(failed.id, 1);
    await service.recordExecutionFailure(
      failed.id,
      1,
      'Agent execution failed',
      true,
    );

    // 9 is a synthetic far-future ordinal, chosen to show that no ordinal,
    // however large, reopens a terminal run.
    await expect(
      service.claimExecutionAttempt(failed.id, 9),
    ).resolves.toBeNull();
    await expect(statusOf(failed.id)).resolves.toMatchObject({
      status: 'FAILED',
      attemptCount: 1,
    });
  });

  it('rejects a completion or failure written against a superseded attempt', async () => {
    const accepted = await service.create(request('superseded-writer-request'));
    await service.claimExecutionAttempt(accepted.id, 1);
    await service.claimExecutionAttempt(accepted.id, 3);

    // The stalled worker that owned ordinal 1 wakes up and tries to finish.
    await expect(
      service.markExecutionSucceeded(accepted.id, 1, { answer: 'stale' }),
    ).resolves.toBe(false);
    await expect(
      service.recordExecutionFailure(
        accepted.id,
        1,
        'Agent execution failed',
        true,
      ),
    ).resolves.toBe(false);

    await expect(statusOf(accepted.id)).resolves.toMatchObject({
      status: 'RUNNING',
      attemptCount: 3,
      output: null,
    });

    // The current owner still can.
    await expect(
      service.markExecutionSucceeded(accepted.id, 3, { answer: 'done' }),
    ).resolves.toBe(true);
  });

  it('refuses a finalizing write against a terminal run at the matching ordinal', async () => {
    // Every other negative case here uses a superseded ordinal, so the CAS
    // alone explains the rejection. These use the ordinal the terminal write
    // was actually made under, which isolates the status guard: without it a
    // SUCCEEDED run could be flipped to FAILED and back.
    //
    // That is reachable, not theoretical. In AgentExecutionHandler the success
    // write sits inside the try block, so anything that throws after it lands
    // in the catch and calls recordExecutionFailure with the same ordinal.
    const succeeded = await service.create(request('terminal-guard-succeeded'));
    await service.claimExecutionAttempt(succeeded.id, 1);
    await service.markExecutionSucceeded(succeeded.id, 1, { answer: 'done' });

    await expect(
      service.recordExecutionFailure(
        succeeded.id,
        1,
        'Agent execution failed',
        true,
      ),
    ).resolves.toBe(false);
    await expect(statusOf(succeeded.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      output: { answer: 'done' },
      lastError: null,
    });

    const failed = await service.create(request('terminal-guard-failed'));
    await service.claimExecutionAttempt(failed.id, 1);
    await service.recordExecutionFailure(
      failed.id,
      1,
      'Agent execution failed',
      true,
    );

    await expect(
      service.markExecutionSucceeded(failed.id, 1, { answer: 'late' }),
    ).resolves.toBe(false);
    await expect(statusOf(failed.id)).resolves.toMatchObject({
      status: 'FAILED',
      output: null,
    });
  });

  it('keeps lastError scoped to the attempt that produced it', async () => {
    const accepted = await service.create(request('last-error-lifecycle'));
    const first = await service.claimExecutionAttempt(accepted.id, 1);
    const startedAt = first?.startedAt;

    await service.recordExecutionFailure(
      accepted.id,
      1,
      'Agent execution failed',
      false,
    );

    // A retrying run must keep its diagnostic; it is the only operator-visible
    // signal of why the run is churning.
    await expect(statusOf(accepted.id)).resolves.toMatchObject({
      status: 'RUNNING',
      lastError: 'Agent execution failed',
      completedAt: null,
    });

    const reclaimed = await service.claimExecutionAttempt(accepted.id, 3);

    expect(reclaimed).toMatchObject({ attemptCount: 3, lastError: null });
    // `startedAt` means when the run first began executing, so a re-claim must
    // not restamp it.
    expect(reclaimed?.startedAt).toEqual(startedAt);

    // The superseded worker reports its own failure late. It must not stamp a
    // stale diagnostic onto the attempt that now owns the run.
    await expect(
      service.recordExecutionFailure(
        accepted.id,
        1,
        'Agent execution failed',
        false,
      ),
    ).resolves.toBe(false);
    await expect(statusOf(accepted.id)).resolves.toMatchObject({
      attemptCount: 3,
      lastError: null,
      completedAt: null,
    });
  });

  it('converges when two deliveries at different ordinals race', async () => {
    const accepted = await service.create(request('concurrent-ordinals'));
    await service.claimExecutionAttempt(accepted.id, 1);

    // Both orderings are legitimate under READ COMMITTED, so assert the
    // invariants rather than which call won: the durable ordinal ends at the
    // highest delivered, and only one worker can finalize.
    await Promise.all([
      service.claimExecutionAttempt(accepted.id, 2),
      service.claimExecutionAttempt(accepted.id, 3),
    ]);

    await expect(statusOf(accepted.id)).resolves.toMatchObject({
      status: 'RUNNING',
      attemptCount: 3,
    });

    const outcomes = await Promise.all([
      service.markExecutionSucceeded(accepted.id, 2, { answer: 'from-2' }),
      service.markExecutionSucceeded(accepted.id, 3, { answer: 'from-3' }),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await expect(statusOf(accepted.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      output: { answer: 'from-3' },
    });
  });

  it('returns the existing run without re-queueing it once it has left QUEUED', async () => {
    const accepted = await service.create(request('re-accept-terminal'));
    await service.claimExecutionAttempt(accepted.id, 1);
    await service.markExecutionSucceeded(accepted.id, 1, { answer: 'done' });

    // A replayed acceptance must not resurrect finished work as a new job.
    const replayed = await service.create(request('re-accept-terminal'));

    expect(replayed.id).toBe(accepted.id);
    expect(replayed.status).toBe('SUCCEEDED');
    await expect(
      prisma.outboxEvent.count({ where: { dedupeKey: accepted.id } }),
    ).resolves.toBe(1);
  });

  it('rejects a non-positive or non-integer active start ordinal', async () => {
    const accepted = await service.create(request('invalid-ordinal-request'));

    await expect(service.claimExecutionAttempt(accepted.id, 0)).rejects.toThrow(
      'positive integer',
    );
    await expect(
      service.claimExecutionAttempt(accepted.id, 1.5),
    ).rejects.toThrow('positive integer');
  });

  it('fails loudly when the run does not exist', async () => {
    await expect(
      service.claimExecutionAttempt(`${fixtureId}-absent`, 1),
    ).rejects.toThrow('does not exist');
  });
});
