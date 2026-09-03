import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { ConfigType } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';

import type { agentsConfig } from '../../../infrastructure/config';
import type {
  QueueJobTransportState,
  QueueProducer,
} from '../../../infrastructure/queue';
import { AgentRunReconciler } from '../../../ai/execution/agent-run-reconciler.service';
import type {
  AgentRunService,
  StaleRunCursor,
} from '../../../ai/execution/agent-run.service';
import type { AgentRunStatus } from '../../../ai/agents/agent.types';
import { MCP_SESSION_TTL_MS } from '../../../ai/agents/agent.types';

/**
 * The recovery decisions, tested without a PostgreSQL, a Redis or a clock that
 * anyone has to trust.
 *
 * Everything asserted here is a judgement the reconciler makes on its own:
 * which transport answers justify writing a terminal outcome, which ones are
 * explicitly not evidence, what an operator is told about either, and how far
 * the scan gets before it has to start over. Those go wrong quietly — a run
 * failed because Redis had merely forgotten its job looks exactly like a run
 * that genuinely failed, and only the absence of the write distinguishes them.
 *
 * The loop is exercised with real timers and short intervals, as the outbox
 * dispatcher's spec does, because the re-arming is the property under test and
 * a faked clock would assert the schedule this test itself wrote.
 */

type Candidate = {
  id: string;
  status: AgentRunStatus;
  attemptCount: number;
  updatedAt: Date;
  runtime: string;
  createdAt: Date;
  organizationId: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fixed epoch, so `updatedAt` is a stable ordering key rather than a clock
 * read: every cursor assertion below compares the exact value the fake row
 * carried.
 */
const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: 'run-1',
  status: 'RUNNING',
  attemptCount: 1,
  updatedAt: new Date(EPOCH),
  /**
   * A worker run by default. Every existing assertion in this file is about
   * the transport path, and a session is reconciled without touching the
   * transport at all — so the default has to be the one that asks.
   */
  runtime: 'mastra',
  createdAt: new Date(EPOCH),
  organizationId: 'org-1',
  ...overrides,
});

/** Oldest-first rows with distinct, ordered `updatedAt` values. */
const page = (...ids: string[]): Candidate[] =>
  ids.map((id, index) =>
    candidate({ id, updatedAt: new Date(EPOCH + index * 1_000) }),
  );

const cursorOf = (row: Candidate): StaleRunCursor => ({
  updatedAt: row.updatedAt,
  id: row.id,
});

describe('AgentRunReconciler', () => {
  const findStaleNonTerminal =
    jest.fn<
      (
        staleBefore: Date,
        limit: number,
        after?: StaleRunCursor,
      ) => Promise<Candidate[]>
    >();
  const reconcileTerminalFailure =
    jest.fn<(runId: string) => Promise<boolean>>();
  const jobTransportState =
    jest.fn<
      (queue: string, jobId: string) => Promise<QueueJobTransportState>
    >();
  // Present only so the "never publishes" test can assert on its absence; the
  // reconciler must never reach for it.
  const publish =
    jest.fn<
      (
        queue: string,
        jobName: string,
        data: unknown,
        options?: unknown,
      ) => Promise<{ jobId: string }>
    >();

  const closeMcpSession =
    jest.fn<
      (input: {
        id: string;
        organizationId: string;
        closedBy: 'client' | 'expiry';
      }) => Promise<boolean>
    >();

  const runs = {
    findStaleNonTerminal,
    reconcileTerminalFailure,
    closeMcpSession,
  } as unknown as AgentRunService;

  const producer = { jobTransportState, publish } as unknown as QueueProducer;

  // Standalone spies rather than bound methods, so several tests below can
  // assert on the *absence* of a log line after clearing them.
  const info = jest.fn<(payload: unknown, message?: string) => void>();
  const warn = jest.fn<(payload: unknown, message?: string) => void>();
  const logger = { info, warn } as unknown as PinoLogger;

  // A deliberately short interval: every lifecycle assertion below is about
  // whether a pass happened at all, never about when precisely.
  const config: ConfigType<typeof agentsConfig> = {
    reconcile: { intervalMs: 40, staleAfterMs: 120_000, batchSize: 50 },
  };

  /**
   * A page small enough to write out by hand, so a test can hit the
   * full-page/short-page boundary the cursor turns on without building fifty
   * rows to do it.
   */
  const withBatchSize = (batchSize: number) =>
    new AgentRunReconciler(
      runs,
      producer,
      { reconcile: { ...config.reconcile, batchSize } },
      logger,
    );

  /** The `after` argument the reconciler used on the nth (0-based) query. */
  const cursorOnCall = (index: number): StaleRunCursor | undefined =>
    findStaleNonTerminal.mock.calls[index][2];

  let reconciler: AgentRunReconciler;

  beforeEach(() => {
    findStaleNonTerminal.mockReset().mockResolvedValue([]);
    closeMcpSession.mockReset().mockResolvedValue(true);
    reconcileTerminalFailure.mockReset().mockResolvedValue(true);
    jobTransportState.mockReset().mockResolvedValue('pending');
    publish.mockReset().mockResolvedValue({ jobId: 'unused' });
    info.mockClear();
    warn.mockClear();

    reconciler = new AgentRunReconciler(runs, producer, config, logger);
  });

  // No test may leave a re-arming timer behind for the next one to observe.
  afterEach(async () => {
    await reconciler.stop(1_000);
  });

  describe('one pass', () => {
    it('finalizes a run whose queue job the transport has failed', async () => {
      findStaleNonTerminal.mockResolvedValue([candidate({ id: 'run-a' })]);
      jobTransportState.mockResolvedValue('failed');

      const pass = await reconciler.reconcileOnce();

      expect(reconcileTerminalFailure).toHaveBeenCalledWith('run-a');
      expect(pass).toEqual({
        abandoned: 0,
        expiredSessions: 0,
        failed: 1,
        liveSessions: 0,
        missing: 0,
        pending: 0,
        racedSessions: 0,
        reconciled: 1,
        examined: 1,
      });
    });

    /**
     * The failure of the sweep would be silent in the other direction: a run
     * still moving through the transport must not be touched, because the
     * handler owns its outcome and will write it.
     */
    it('leaves a run alone while its job is still in the transport', async () => {
      findStaleNonTerminal.mockResolvedValue([candidate({ id: 'run-a' })]);
      jobTransportState.mockResolvedValue('pending');

      const pass = await reconciler.reconcileOnce();

      expect(reconcileTerminalFailure).not.toHaveBeenCalled();
      expect(pass).toEqual({
        abandoned: 0,
        expiredSessions: 0,
        liveSessions: 0,
        examined: 1,
        failed: 0,
        missing: 0,
        pending: 1,
        racedSessions: 0,
        reconciled: 0,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    /**
     * Absence is not evidence. Redis dropping a job — retention, a flush, an
     * outbox event not yet published — says nothing about whether the work will
     * happen, so the row is reported and left exactly as it was. Failing on
     * absence would turn a backlog older than the staleness threshold into
     * destroyed work.
     */
    it('reports a run with no transport record without writing its state', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({ id: 'run-a', status: 'QUEUED' }),
      ]);
      jobTransportState.mockResolvedValue('missing');

      const pass = await reconciler.reconcileOnce();

      expect(reconcileTerminalFailure).not.toHaveBeenCalled();
      expect(pass).toEqual({
        abandoned: 0,
        expiredSessions: 0,
        liveSessions: 0,
        examined: 1,
        failed: 0,
        missing: 1,
        pending: 0,
        racedSessions: 0,
        reconciled: 0,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'transport_record_missing',
          count: 1,
          runIds: ['run-a'],
        }),
        expect.any(String),
      );
    });

    /**
     * The run reached a terminal status between the candidate query and the
     * write — a late worker completed it, or a concurrent reconciler got there
     * first — so the status-filtered update matched nothing. That is the
     * mechanism working, not a failure: the pass counts the transport verdict
     * it observed but must not claim to have finalized anything, and an
     * operator must not be told a run was failed when it was not.
     */
    it('counts a transport failure it did not get to write as unreconciled', async () => {
      findStaleNonTerminal.mockResolvedValue([candidate({ id: 'run-a' })]);
      jobTransportState.mockResolvedValue('failed');
      reconcileTerminalFailure.mockResolvedValue(false);

      const pass = await reconciler.reconcileOnce();

      expect(pass).toEqual({
        abandoned: 0,
        expiredSessions: 0,
        liveSessions: 0,
        examined: 1,
        failed: 1,
        missing: 0,
        pending: 0,
        racedSessions: 0,
        reconciled: 0,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    /**
     * A `false` write still finishes the observation.
     *
     * Claimed in `advancePast`'s contract and otherwise untested: a run another
     * writer already made terminal has left the candidate set, so it cannot pin
     * the scan and the cursor must move on. Only a *rejecting* write holds the
     * cursor back — pinning on `false` too would stall the sweep on a row the
     * query is never going to return again.
     */
    it('advances past a run another writer had already finalized', async () => {
      const rows = page('already-terminal', 'behind-it');
      reconciler = withBatchSize(2);
      findStaleNonTerminal.mockResolvedValueOnce(rows).mockResolvedValue([]);
      jobTransportState.mockResolvedValue('failed');
      reconcileTerminalFailure.mockResolvedValue(false);

      await reconciler.reconcileOnce();
      await reconciler.reconcileOnce();

      expect(cursorOnCall(1)).toEqual(cursorOf(rows[1]));
    });

    it('counts a mixed batch exactly', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({ id: 'failed-1' }),
        candidate({ id: 'pending-1' }),
        candidate({ id: 'failed-2' }),
        candidate({ id: 'missing-1' }),
      ]);
      jobTransportState.mockImplementation((_queue, jobId) =>
        Promise.resolve(
          jobId.startsWith('failed')
            ? 'failed'
            : jobId.startsWith('missing')
              ? 'missing'
              : 'pending',
        ),
      );

      const pass = await reconciler.reconcileOnce();

      expect(pass).toEqual({
        abandoned: 0,
        expiredSessions: 0,
        liveSessions: 0,
        examined: 4,
        failed: 2,
        missing: 1,
        pending: 1,
        racedSessions: 0,
        reconciled: 2,
      });
      expect(reconcileTerminalFailure.mock.calls).toEqual([
        ['failed-1'],
        ['failed-2'],
      ]);
    });

    // The common case by far, and the one that must cost nothing: an idle
    // deployment should not touch Redis once per interval per queue.
    /**
     * Shutdown begins mid-batch.
     *
     * The tail is not lost, only postponed — nothing was claimed or leased, so
     * the next process rebuilds the list. What matters is that the pass says
     * so: an `examined` that no longer equals the sum of the outcomes would
     * read as work that vanished.
     */
    it('reports the tail it abandoned when shutdown interrupts a batch', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({ id: 'run-a' }),
        candidate({ id: 'run-b' }),
        candidate({ id: 'run-c' }),
      ]);
      jobTransportState.mockImplementation(async (_queue, jobId) => {
        // Stopping partway through, exactly as the shutdown step does.
        if (jobId === 'run-a') await reconciler.stop(0);
        return 'pending';
      });

      const pass = await reconciler.reconcileOnce();

      expect(pass).toEqual({
        abandoned: 2,
        expiredSessions: 0,
        liveSessions: 0,
        examined: 3,
        failed: 0,
        missing: 0,
        pending: 1,
        racedSessions: 0,
        reconciled: 0,
      });
      // The accounting still balances, which is the point of the counter.
      expect(
        pass.pending +
          pass.failed +
          pass.missing +
          pass.expiredSessions +
          pass.liveSessions +
          pass.racedSessions +
          pass.abandoned,
      ).toBe(pass.examined);
      expect(jobTransportState).toHaveBeenCalledTimes(1);
    });

    it('touches the transport not at all when nothing is stale', async () => {
      findStaleNonTerminal.mockResolvedValue([]);

      const pass = await reconciler.reconcileOnce();

      expect(pass).toEqual({
        abandoned: 0,
        expiredSessions: 0,
        liveSessions: 0,
        examined: 0,
        failed: 0,
        missing: 0,
        pending: 0,
        racedSessions: 0,
        reconciled: 0,
      });
      expect(jobTransportState).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    });

    it('asks PostgreSQL for one batch of rows older than the staleness threshold', async () => {
      const before = Date.now();
      await reconciler.reconcileOnce();
      const after = Date.now();

      expect(findStaleNonTerminal).toHaveBeenCalledTimes(1);
      const [staleBefore, limit] = findStaleNonTerminal.mock.calls[0];

      expect(staleBefore).toBeInstanceOf(Date);
      expect(staleBefore.getTime()).toBeGreaterThanOrEqual(
        before - config.reconcile.staleAfterMs,
      );
      expect(staleBefore.getTime()).toBeLessThanOrEqual(
        after - config.reconcile.staleAfterMs,
      );
      expect(limit).toBe(config.reconcile.batchSize);
    });

    /**
     * Sequential on purpose. A batch fanned out against a degraded Redis
     * produces `batchSize` slow commands at once instead of one, and a recovery
     * sweep has nothing to gain by finishing sooner.
     */
    it('examines candidates one at a time rather than fanning the batch out', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({ id: 'run-a' }),
        candidate({ id: 'run-b' }),
        candidate({ id: 'run-c' }),
      ]);

      const order: string[] = [];
      let inFlight = 0;
      let peakInFlight = 0;

      jobTransportState.mockImplementation(async (_queue, jobId) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        order.push(`state:${jobId}`);
        // Yields the microtask queue, so a concurrent implementation would have
        // started every other candidate before this one returned.
        await sleep(5);
        inFlight -= 1;
        return 'failed';
      });
      reconcileTerminalFailure.mockImplementation((runId) => {
        order.push(`write:${runId}`);
        return Promise.resolve(true);
      });

      await reconciler.reconcileOnce();

      expect(peakInFlight).toBe(1);
      expect(order).toEqual([
        'state:run-a',
        'write:run-a',
        'state:run-b',
        'write:run-b',
        'state:run-c',
        'write:run-c',
      ]);
    });

    /**
     * The reconciler reads the transport's verdict and nothing else — no
     * `failedReason`, no stack, no provider text — so an operator sees only
     * application-owned columns and a fixed code. Anything else would copy a
     * string the transport authored into logs the application is responsible
     * for, which is how provider payloads escape.
     */
    it('logs only application-owned fields and a fixed reason code', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({ id: 'run-a', status: 'RUNNING', attemptCount: 2 }),
        candidate({ id: 'run-b', status: 'QUEUED', attemptCount: 0 }),
      ]);
      jobTransportState.mockImplementation((_queue, jobId) =>
        Promise.resolve(jobId === 'run-a' ? 'failed' : 'missing'),
      );

      await reconciler.reconcileOnce();

      // The complete vocabulary, and `previousStatus` is the only name either
      // branch uses for the run's status — a log query keyed on it must not
      // silently miss one of the two reasons.
      const allowedKeys = [
        'abandoned',
        'attemptCount',
        'count',
        'examined',
        'expiredSessions',
        'failed',
        'liveSessions',
        'missing',
        'pending',
        'previousStatus',
        'racedSessions',
        'reason',
        'reconciled',
        'runId',
        'runIds',
      ];
      const allowedStrings = [
        'QUEUED',
        'RUNNING',
        'run-a',
        'run-b',
        'terminal_transport_failure',
        'transport_record_missing',
      ];
      const reasons: unknown[] = [];

      /**
       * Recurses into arrays rather than skipping them. `runIds` carries a
       * sample of ids, and a value that only escapes when it is the element of
       * a list is exactly the leak an allowlist checked one level deep misses.
       */
      const assertNoUnknownString = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) assertNoUnknownString(item);
          return;
        }

        if (typeof value === 'string') expect(allowedStrings).toContain(value);
      };

      for (const [payload] of [...warn.mock.calls, ...info.mock.calls]) {
        expect(typeof payload).toBe('object');
        const fields = payload as Record<string, unknown>;

        for (const [key, value] of Object.entries(fields)) {
          expect(allowedKeys).toContain(key);
          assertNoUnknownString(value);
        }

        if ('reason' in fields) reasons.push(fields.reason);
      }

      expect(reasons).toEqual([
        'terminal_transport_failure',
        'transport_record_missing',
      ]);
    });

    /**
     * One line per pass, not one line per candidate per pass.
     *
     * These runs are by definition the ones the pass changes nothing about, so
     * the previous per-candidate form produced an unbounded stream describing a
     * static set: the same ids, every interval, forever. At a 40s interval and
     * a page of fifty that is tens of thousands of identical lines a day, which
     * is how the signal that a queue lost its jobs becomes the noise an
     * operator filters out.
     */
    it('summarizes every stranded run in a single line per pass', async () => {
      const missing = page(...Array.from({ length: 8 }, (_, i) => `run-${i}`));
      findStaleNonTerminal.mockResolvedValue(missing);
      jobTransportState.mockResolvedValue('missing');

      const pass = await reconciler.reconcileOnce();

      expect(pass.missing).toBe(8);

      const missingWarns = warn.mock.calls.filter(
        ([payload]) =>
          (payload as { reason?: string }).reason ===
          'transport_record_missing',
      );

      // One, whatever the size of the set — the assertion the per-candidate
      // form fails on with N = 8.
      expect(missingWarns).toHaveLength(1);

      const [payload] = missingWarns[0];
      expect(payload).toEqual({
        reason: 'transport_record_missing',
        count: 8,
        // A sample, so the line stays one line however large the set grows.
        runIds: ['run-0', 'run-1', 'run-2', 'run-3', 'run-4'],
      });
    });

    /**
     * The reconciler observes; it never re-queues.
     *
     * A fresh job would restart `attemptsStarted` at 1 while the run already
     * holds a higher `attemptCount`, so the monotonic fence would reject the
     * claim, the handler would return normally, and BullMQ would record a
     * completed job for work that never ran — a stranded run replaced by a
     * silently lost one. Every transport verdict is covered here because the
     * temptation to "just retry it" lives on the missing branch.
     */
    /**
     * An abandoned MCP session is finalized here, and nowhere else.
     *
     * A session has no queue job by design — acceptance appends no outbox
     * event — so the transport answers `missing` for every session on every
     * pass, and `missing` is deliberately not terminal. Left to that path the
     * row would say `RUNNING` forever while being logged as stranded
     * indefinitely: a durable lie plus an unbounded stream of lines about it.
     */
    it('closes an expired MCP session without asking the transport', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({
          id: 'session-a',
          runtime: 'mcp',
          organizationId: 'org-7',
          createdAt: new Date(EPOCH - MCP_SESSION_TTL_MS - 1_000),
        }),
      ]);
      closeMcpSession.mockResolvedValue(true);

      const pass = await reconciler.reconcileOnce();

      expect(closeMcpSession).toHaveBeenCalledWith({
        id: 'session-a',
        organizationId: 'org-7',
        closedBy: 'expiry',
      });
      // Never asked: there is nothing in the transport to ask about.
      expect(jobTransportState).not.toHaveBeenCalled();
      expect(reconcileTerminalFailure).not.toHaveBeenCalled();

      expect(pass).toEqual({
        abandoned: 0,
        examined: 1,
        expiredSessions: 1,
        failed: 0,
        liveSessions: 0,
        missing: 0,
        pending: 0,
        racedSessions: 0,
        reconciled: 0,
      });
    });

    /**
     * A session inside its lifetime is left strictly alone.
     *
     * It is stale by `updatedAt` — nothing touches the run row on a tool call
     * — so it appears in every sweep. Being a candidate must not be enough to
     * end it.
     */
    it('leaves a live MCP session untouched', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({
          id: 'session-b',
          runtime: 'mcp',
          createdAt: new Date(Date.now()),
        }),
      ]);

      const pass = await reconciler.reconcileOnce();

      expect(closeMcpSession).not.toHaveBeenCalled();
      expect(jobTransportState).not.toHaveBeenCalled();

      expect(pass).toMatchObject({
        examined: 1,
        expiredSessions: 0,
        liveSessions: 1,
      });
    });

    /**
     * The client closed it first, between this pass's read and its write.
     *
     * Its own outcome stands and there is nothing to correct, so the pass must
     * not claim an expiry it did not perform — the two disagree about
     * `closedBy`, and a row whose history contradicts itself is worse than an
     * uncounted sweep.
     */
    it('does not count a session the client closed first', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({
          id: 'session-c',
          runtime: 'mcp',
          createdAt: new Date(EPOCH - MCP_SESSION_TTL_MS - 1_000),
        }),
      ]);
      closeMcpSession.mockResolvedValue(false);

      const pass = await reconciler.reconcileOnce();

      expect(closeMcpSession).toHaveBeenCalledTimes(1);
      expect(pass).toEqual({
        abandoned: 0,
        examined: 1,
        expiredSessions: 0,
        failed: 0,
        liveSessions: 0,
        missing: 0,
        pending: 0,
        racedSessions: 1,
        reconciled: 0,
      });
      expect(
        pass.pending +
          pass.failed +
          pass.missing +
          pass.expiredSessions +
          pass.liveSessions +
          pass.racedSessions +
          pass.abandoned,
      ).toBe(pass.examined);
    });

    /**
     * A mixed batch, so neither branch can be reached by the other's rows.
     */
    it('reconciles worker runs and sessions in one pass', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({ id: 'run-a' }),
        candidate({
          id: 'session-a',
          runtime: 'mcp',
          createdAt: new Date(EPOCH - MCP_SESSION_TTL_MS - 1_000),
        }),
        candidate({
          id: 'session-b',
          runtime: 'mcp',
          createdAt: new Date(Date.now()),
        }),
      ]);
      jobTransportState.mockResolvedValue('failed');
      closeMcpSession.mockResolvedValue(true);

      const pass = await reconciler.reconcileOnce();

      // Asked about exactly one run: the only one with a job.
      expect(jobTransportState).toHaveBeenCalledTimes(1);
      expect(pass).toMatchObject({
        examined: 3,
        failed: 1,
        reconciled: 1,
        expiredSessions: 1,
        liveSessions: 1,
        racedSessions: 0,
      });
      expect(
        pass.pending +
          pass.failed +
          pass.missing +
          pass.expiredSessions +
          pass.liveSessions +
          pass.racedSessions +
          pass.abandoned,
      ).toBe(pass.examined);
    });

    it('never publishes a job on any path', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({ id: 'failed-written' }),
        candidate({ id: 'failed-unwritten' }),
        candidate({ id: 'missing-1' }),
        candidate({ id: 'pending-1' }),
      ]);
      jobTransportState.mockImplementation((_queue, jobId) =>
        Promise.resolve(
          jobId.startsWith('failed')
            ? 'failed'
            : jobId.startsWith('missing')
              ? 'missing'
              : 'pending',
        ),
      );
      reconcileTerminalFailure.mockImplementation((runId) =>
        Promise.resolve(runId === 'failed-written'),
      );

      const pass = await reconciler.reconcileOnce();

      expect(pass).toEqual({
        abandoned: 0,
        expiredSessions: 0,
        liveSessions: 0,
        examined: 4,
        failed: 2,
        missing: 1,
        pending: 1,
        racedSessions: 0,
        reconciled: 1,
      });
      expect(publish).not.toHaveBeenCalled();

      // And not from the loop either, where a re-queue would compound once per
      // interval instead of once.
      reconciler.start();
      await sleep(150);

      expect(findStaleNonTerminal.mock.calls.length).toBeGreaterThan(1);
      expect(publish).not.toHaveBeenCalled();
    });

    /**
     * Redis fails partway through the batch.
     *
     * The pass must surface the rejection rather than absorb it — the loop's
     * catch logs it and re-arms — and it must not turn a transport that stopped
     * answering into terminal writes for rows it never asked about. Writing the
     * unexamined tail on an infrastructure error is the one way this component
     * could destroy live work.
     */
    it('stops at a transport error and writes nothing for the rows it never examined', async () => {
      findStaleNonTerminal.mockResolvedValue(
        page('run-a', 'run-b', 'run-c', 'run-d'),
      );
      jobTransportState.mockImplementation((_queue, jobId) => {
        if (jobId === 'run-b') {
          return Promise.reject(new Error('connection reset'));
        }

        return Promise.resolve('failed');
      });

      await expect(reconciler.reconcileOnce()).rejects.toThrow(
        'connection reset',
      );

      // Only the row whose verdict was actually observed was written.
      expect(reconcileTerminalFailure.mock.calls).toEqual([['run-a']]);
      // And the pass never reached run-c or run-d to ask about them.
      expect(jobTransportState.mock.calls.map(([, jobId]) => jobId)).toEqual([
        'run-a',
        'run-b',
      ]);
    });
  });

  /**
   * The scan cursor.
   *
   * Progress state, not correctness state. A candidate the pass cannot act on
   * is left unwritten, so its `updatedAt` never advances and an oldest-first
   * query returns it again on the next pass — and the pass after that, forever.
   * Once `batchSize` such rows exist the sweep can never reach a newer run, and
   * the one mechanism that finalizes stranded runs silently stops finalizing
   * anything while logging that it is busy. Redis restored empty, `batchSize`
   * outbox events parked, or a failure storm trimming the failed set past its
   * retention all produce exactly that population.
   */
  describe('the scan cursor', () => {
    /**
     * THE HEADLINE TEST: no head-of-line starvation.
     *
     * A full page of runs the pass can do nothing about must not be the next
     * pass's page. The transport double answers by cursor, so a reconciler that
     * dropped the cursor would be handed the same three rows a second time and
     * would never see the genuinely failed run waiting behind them — which is
     * both assertions below.
     */
    it('resumes past a full page of unactionable runs instead of re-reading it forever', async () => {
      reconciler = withBatchSize(3);

      const stuck = page('stuck-a', 'stuck-b', 'stuck-c');
      const behindThem = [
        candidate({
          id: 'genuinely-failed',
          updatedAt: new Date(EPOCH + 60_000),
        }),
      ];

      findStaleNonTerminal.mockImplementation((_staleBefore, _limit, after) =>
        // Oldest-first with a cursor: without one, the query can only ever
        // answer with the stuck page again.
        Promise.resolve(after === undefined ? stuck : behindThem),
      );
      jobTransportState.mockImplementation((_queue, jobId) =>
        Promise.resolve(jobId === 'genuinely-failed' ? 'failed' : 'missing'),
      );

      const first = await reconciler.reconcileOnce();
      expect(first).toMatchObject({ examined: 3, missing: 3, reconciled: 0 });

      const second = await reconciler.reconcileOnce();

      // Pass 2 asked for the rows *after* the last row pass 1 reached.
      expect(cursorOnCall(1)).toEqual(cursorOf(stuck[2]));
      // And so it finally reached the run that actually needed finalizing.
      expect(reconcileTerminalFailure).toHaveBeenCalledWith('genuinely-failed');
      expect(second).toMatchObject({ examined: 1, failed: 1, reconciled: 1 });
    });

    /**
     * The advance is per candidate finished, not per candidate written. A
     * cursor that only moved for reconciled rows would stall on the first
     * `missing` or `pending` row — the two answers that leave the row unwritten
     * and therefore permanently at the head of the query. (Finished is not the
     * same as reached: see the terminal-write test below, where a candidate is
     * reached and deliberately not advanced past.)
     */
    it('advances past candidates it could not act on, not just the ones it wrote', async () => {
      reconciler = withBatchSize(3);

      const rows = page('written-1', 'missing-1', 'pending-1');
      findStaleNonTerminal.mockResolvedValueOnce(rows).mockResolvedValue([]);
      jobTransportState.mockImplementation((_queue, jobId) =>
        Promise.resolve(
          jobId === 'written-1'
            ? 'failed'
            : jobId === 'missing-1'
              ? 'missing'
              : 'pending',
        ),
      );

      await reconciler.reconcileOnce();
      await reconciler.reconcileOnce();

      // The last row reached, which is the trailing `pending` one — not the
      // reconciled row two places before it.
      expect(cursorOnCall(1)).toEqual(cursorOf(rows[2]));
    });

    // Exactly `batchSize` rows means there is probably more behind them, so the
    // cycle continues from where it stopped.
    it('carries a cursor forward when a full page comes back', async () => {
      reconciler = withBatchSize(3);

      const rows = page('run-a', 'run-b', 'run-c');
      findStaleNonTerminal.mockResolvedValueOnce(rows).mockResolvedValue([]);

      await reconciler.reconcileOnce();
      await reconciler.reconcileOnce();

      expect(cursorOnCall(0)).toBeUndefined();
      expect(cursorOnCall(1)).toEqual(cursorOf(rows[2]));
    });

    /**
     * What makes the scan cyclic rather than one-way.
     *
     * A cursor that only ever moved forward would walk off the end of the table
     * and stop examining anything; runs that became stale behind it would never
     * be looked at again. Reaching the end of the rows resets it, so the next
     * pass starts from the oldest run and the whole set is covered repeatedly.
     */
    it('starts again from the oldest run once a page comes back short', async () => {
      reconciler = withBatchSize(3);

      const rows = page('run-a', 'run-b', 'run-c');
      findStaleNonTerminal.mockResolvedValueOnce(rows).mockResolvedValue([]);

      await reconciler.reconcileOnce(); // Full page: cursor set.
      await reconciler.reconcileOnce(); // Short page: cycle over.
      await reconciler.reconcileOnce();

      expect(cursorOnCall(1)).toEqual(cursorOf(rows[2]));
      expect(cursorOnCall(2)).toBeUndefined();
    });

    /**
     * A short page ends the cycle immediately, not one pass later.
     *
     * The reset has to happen after the loop, because the loop advances the
     * cursor for every candidate it finishes — reset first and the last row of
     * a short page would overwrite it, costing an extra empty query every cycle
     * before the wrap took effect.
     */
    it('wraps back to the oldest run immediately after a short page', async () => {
      reconciler = withBatchSize(3);

      const rows = page('run-a', 'run-b');
      findStaleNonTerminal.mockResolvedValueOnce(rows).mockResolvedValue([]);

      await reconciler.reconcileOnce();
      await reconciler.reconcileOnce();

      expect(cursorOnCall(1)).toBeUndefined();
    });

    /**
     * THE OTHER HEADLINE TEST: a proven-failed run survives a database blip.
     *
     * This is the one ordering in the loop that can lose a run permanently. The
     * transport has already answered `failed`, so the pass knows this row needs
     * finalizing; if the cursor moved on that verdict and the write then
     * rejected, the next pass would resume *after* the row nobody wrote. It is
     * not one interval of latency, because the row's `updatedAt` never moves
     * and only a wrap could bring it back — so the backlog here deliberately
     * keeps every page full, leaving the scan no short page to wrap on. The run
     * would stay `RUNNING` while the sweep logged healthy passes.
     *
     * The table drops finalized rows the way the real query does, so the pages
     * shift as work completes instead of being a fixed script.
     */
    it('presents a run again when its terminal write rejects, instead of scanning past it', async () => {
      reconciler = withBatchSize(3);

      const table = page(
        'run-a',
        'run-b',
        'run-c',
        'run-d',
        'run-e',
        'run-f',
        'run-g',
      );
      const finalized = new Set<string>();

      findStaleNonTerminal.mockImplementation((_staleBefore, limit, after) =>
        Promise.resolve(
          table
            .filter(
              (row) =>
                !finalized.has(row.id) &&
                (after === undefined || row.updatedAt > after.updatedAt),
            )
            .slice(0, limit),
        ),
      );
      jobTransportState.mockResolvedValue('failed');

      let blip = true;
      reconcileTerminalFailure.mockImplementation((runId) => {
        if (runId === 'run-b' && blip) {
          blip = false;

          return Promise.reject(
            new Error('the database system is shutting down'),
          );
        }

        finalized.add(runId);

        return Promise.resolve(true);
      });

      await expect(reconciler.reconcileOnce()).rejects.toThrow(
        'the database system is shutting down',
      );

      // The verdict on run-b was observed, and nothing recorded it.
      expect([...finalized]).toEqual(['run-a']);

      const second = await reconciler.reconcileOnce();

      // The pass after the blip resumed at run-a — so run-b, whose failure this
      // sweep had already proven, was the very next row it was handed.
      expect(cursorOnCall(1)).toEqual(cursorOf(table[0]));
      expect(reconcileTerminalFailure.mock.calls.map(([id]) => id)).toEqual([
        'run-a',
        'run-b', // rejected
        'run-b', // retried
        'run-c',
        'run-d',
      ]);
      expect(finalized.has('run-b')).toBe(true);

      // A full page again, so the cycle never wrapped: the retry came from the
      // cursor staying put, not from the scan starting over.
      expect(second).toMatchObject({ examined: 3, failed: 3, reconciled: 3 });
    });

    /**
     * A pass that fails must retry its page, not skip it. Advancing on an
     * outage would let one unreachable Redis hide a page of stranded runs until
     * the whole cycle came round again.
     */
    it('leaves the cursor where it was when a pass throws', async () => {
      reconciler = withBatchSize(3);

      const rows = page('run-a', 'run-b', 'run-c');
      findStaleNonTerminal
        .mockResolvedValueOnce(rows)
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValue([]);

      await reconciler.reconcileOnce();
      await expect(reconciler.reconcileOnce()).rejects.toThrow(
        'connection refused',
      );
      await reconciler.reconcileOnce();

      // The failed pass and the one after it asked for the same page.
      expect(cursorOnCall(2)).toEqual(cursorOnCall(1));
      expect(cursorOnCall(2)).toEqual(cursorOf(rows[2]));
    });

    /**
     * Losing the cursor costs time, not coverage.
     *
     * It lives in memory on purpose: a restart, a second worker, or a crash
     * mid-cycle simply resumes from the oldest run and walks the same cycle
     * again. Correctness rests on PostgreSQL alone, and nothing here may grow
     * into state that has to be persisted or shared.
     */
    it('starts from the oldest run again after a restart', async () => {
      reconciler = withBatchSize(3);
      findStaleNonTerminal.mockResolvedValue(page('run-a', 'run-b', 'run-c'));

      await reconciler.reconcileOnce();
      expect(cursorOnCall(0)).toBeUndefined();

      // A fresh instance stands in for the restarted process.
      const restarted = withBatchSize(3);
      await restarted.reconcileOnce();

      expect(cursorOnCall(1)).toBeUndefined();
    });
  });

  describe('the loop', () => {
    /**
     * A worker restart is itself a source of stalled jobs, so sweeping before
     * the fleet has settled would examine runs whose recovery is still under
     * way. The first pass is therefore a full interval away, not immediate.
     */
    it('sweeps nothing until a full interval has elapsed', async () => {
      reconciler = new AgentRunReconciler(
        runs,
        producer,
        { reconcile: { ...config.reconcile, intervalMs: 200 } },
        logger,
      );

      reconciler.start();
      expect(findStaleNonTerminal).not.toHaveBeenCalled();

      await sleep(60);
      expect(findStaleNonTerminal).not.toHaveBeenCalled();

      await sleep(300);
      expect(findStaleNonTerminal.mock.calls.length).toBeGreaterThan(0);
    });

    /**
     * The outage path, and the one that must not be able to end the loop. A
     * pass that rejects because PostgreSQL or Redis was unreachable costs one
     * interval: nothing durable was written, the next pass recomputes its
     * candidates from scratch, and a rejection that escaped instead would leave
     * the only recovery mechanism dead until somebody restarted the worker.
     */
    it('survives a pass that rejects and sweeps again on the next interval', async () => {
      findStaleNonTerminal.mockRejectedValue(new Error('connection refused'));

      reconciler.start();
      await sleep(200);

      expect(findStaleNonTerminal.mock.calls.length).toBeGreaterThan(1);
      expect(warn).toHaveBeenCalledWith(
        expect.anything(),
        'Agent run reconciliation pass failed; retrying next interval',
      );
    });

    // The same guarantee for a failure raised halfway through a batch rather
    // than by the candidate query: a partially completed pass re-arms too.
    it('re-arms after the transport fails partway through a batch', async () => {
      findStaleNonTerminal.mockResolvedValue(page('run-a', 'run-b'));
      jobTransportState.mockImplementation((_queue, jobId) =>
        jobId === 'run-a'
          ? Promise.resolve('pending')
          : Promise.reject(new Error('connection reset')),
      );

      reconciler.start();
      await sleep(200);

      expect(findStaleNonTerminal.mock.calls.length).toBeGreaterThan(1);
      expect(warn).toHaveBeenCalledWith(
        expect.anything(),
        'Agent run reconciliation pass failed; retrying next interval',
      );
      expect(reconcileTerminalFailure).not.toHaveBeenCalled();
    });

    it('sweeps until stopped, then leaves the loop idle', async () => {
      reconciler.start();
      await sleep(150);
      await reconciler.stop(1_000);

      const sweepsWhileRunning = findStaleNonTerminal.mock.calls.length;
      expect(sweepsWhileRunning).toBeGreaterThan(0);

      await sleep(150);
      expect(findStaleNonTerminal.mock.calls.length).toBe(sweepsWhileRunning);
    });

    it('refuses to restart after stopping', async () => {
      await reconciler.stop(1_000);
      reconciler.start();

      // Nothing scheduled, so nothing is ever queried. A reconciler restarted
      // during shutdown would write terminal outcomes while its transport and
      // database connections were being closed.
      await sleep(150);
      expect(findStaleNonTerminal).not.toHaveBeenCalled();
    });

    /**
     * Two timers would mean two overlapping passes examining the same candidate
     * rows, which is the concurrency the re-arming design exists to avoid.
     * Blocking the first pass makes the duplicate observable: a second loop
     * fires its own timer at the same interval and produces a second query.
     */
    it('starts one loop however many times it is started', async () => {
      let release: (() => void) | undefined;
      findStaleNonTerminal.mockImplementation(
        () =>
          new Promise<Candidate[]>((resolve) => {
            release = () => resolve([]);
          }),
      );

      reconciler.start();
      reconciler.start();
      await sleep(150);

      expect(findStaleNonTerminal).toHaveBeenCalledTimes(1);

      release?.();
    });

    /**
     * `stop()` waits for the pass in progress, but only for its budget.
     *
     * An unbounded wait turns a bounded worker drain into a SIGKILL at the
     * container's grace deadline: the shutdown step blocks on a pass that is
     * itself blocked on a hung Redis command, every other shutdown step behind
     * it never runs, and the orchestrator kills the process mid-write. The
     * abandoned pass is safe by construction — it holds no lease and rebuilds
     * its candidates next time — so waiting past the budget buys nothing.
     */
    it('returns from stop within its budget even if the pass never settles', async () => {
      let release: (() => void) | undefined;
      findStaleNonTerminal.mockImplementation(
        () =>
          new Promise<Candidate[]>((resolve) => {
            release = () => resolve([]);
          }),
      );

      reconciler.start();
      // Past one interval, so a pass is genuinely in flight and `stop()` has
      // something to wait on rather than nothing.
      await sleep(120);
      expect(findStaleNonTerminal).toHaveBeenCalledTimes(1);

      const startedAt = Date.now();
      await reconciler.stop(50);
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(400);

      // Let the abandoned pass finish so the suite leaves nothing pending.
      release?.();
      await sleep(10);
    });
  });
});
