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

import type { agentsConfig } from '../../config';
import type { QueueJobTransportState, QueueProducer } from '../../core/queue';
import { AgentRunReconciler } from '../agent-run-reconciler.service';
import type { AgentRunService } from '../agent-run.service';
import type { AgentRunStatus } from '../agent.types';

/**
 * The recovery decisions, tested without a PostgreSQL, a Redis or a clock that
 * anyone has to trust.
 *
 * Everything asserted here is a judgement the reconciler makes on its own:
 * which transport answers justify writing a terminal outcome, which ones are
 * explicitly not evidence, and what an operator is told about either. Those go
 * wrong quietly — a run failed because Redis had merely forgotten its job looks
 * exactly like a run that genuinely failed, and only the absence of the write
 * distinguishes them.
 *
 * The loop is exercised with real timers and short intervals, as the outbox
 * dispatcher's spec does, because the re-arming is the property under test and
 * a faked clock would assert the schedule this test itself wrote.
 */

type Candidate = { id: string; status: AgentRunStatus; attemptCount: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: 'run-1',
  status: 'RUNNING',
  attemptCount: 1,
  ...overrides,
});

describe('AgentRunReconciler', () => {
  const findStaleNonTerminal =
    jest.fn<(staleBefore: Date, limit: number) => Promise<Candidate[]>>();
  const reconcileTerminalFailure =
    jest.fn<(runId: string) => Promise<boolean>>();
  const jobTransportState =
    jest.fn<
      (queue: string, jobId: string) => Promise<QueueJobTransportState>
    >();

  const runs = {
    findStaleNonTerminal,
    reconcileTerminalFailure,
  } as unknown as AgentRunService;

  const producer = { jobTransportState } as unknown as QueueProducer;

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

  let reconciler: AgentRunReconciler;

  beforeEach(() => {
    findStaleNonTerminal.mockReset().mockResolvedValue([]);
    reconcileTerminalFailure.mockReset().mockResolvedValue(true);
    jobTransportState.mockReset().mockResolvedValue('pending');
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
        examined: 1,
        failed: 1,
        missing: 0,
        pending: 0,
        reconciled: 1,
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
        examined: 1,
        failed: 0,
        missing: 0,
        pending: 1,
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
        examined: 1,
        failed: 0,
        missing: 1,
        pending: 0,
        reconciled: 0,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-a',
          reason: 'transport_record_missing',
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
        examined: 1,
        failed: 1,
        missing: 0,
        pending: 0,
        reconciled: 0,
      });
      expect(warn).not.toHaveBeenCalled();
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
        examined: 4,
        failed: 2,
        missing: 1,
        pending: 1,
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
        examined: 3,
        failed: 0,
        missing: 0,
        pending: 1,
        reconciled: 0,
      });
      // The accounting still balances, which is the point of the counter.
      expect(pass.pending + pass.failed + pass.missing + pass.abandoned).toBe(
        pass.examined,
      );
      expect(jobTransportState).toHaveBeenCalledTimes(1);
    });

    it('touches the transport not at all when nothing is stale', async () => {
      findStaleNonTerminal.mockResolvedValue([]);

      const pass = await reconciler.reconcileOnce();

      expect(pass).toEqual({
        abandoned: 0,
        examined: 0,
        failed: 0,
        missing: 0,
        pending: 0,
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
        'examined',
        'failed',
        'missing',
        'pending',
        'previousStatus',
        'reason',
        'reconciled',
        'runId',
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

      for (const [payload] of [...warn.mock.calls, ...info.mock.calls]) {
        expect(typeof payload).toBe('object');
        const fields = payload as Record<string, unknown>;

        for (const [key, value] of Object.entries(fields)) {
          expect(allowedKeys).toContain(key);
          if (typeof value === 'string') {
            expect(allowedStrings).toContain(value);
          }
        }

        if ('reason' in fields) reasons.push(fields.reason);
      }

      expect(reasons).toEqual([
        'terminal_transport_failure',
        'transport_record_missing',
      ]);
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
  });
});
