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

import type { agentsConfig } from '../../../../src/infrastructure/config';
import type {
  QueueJobTransportState,
  QueueProducer,
} from '../../../../src/infrastructure/queue';
import { AgentRunReconciler } from '../../../../src/ai/execution/agent-run-reconciler.service';
import type {
  AgentRunService,
  StaleRunCursor,
} from '../../../../src/ai/execution/agent-run.service';
import type { AgentRunStatus } from '../../../../src/ai/agents/agent.types';
import { MCP_SESSION_TTL_MS } from '../../../../src/ai/agents/agent.types';

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

const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: 'run-1',
  status: 'RUNNING',
  attemptCount: 1,
  updatedAt: new Date(EPOCH),
  runtime: 'mastra',
  createdAt: new Date(EPOCH),
  organizationId: 'org-1',
  ...overrides,
});

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

  const info = jest.fn<(payload: unknown, message?: string) => void>();
  const warn = jest.fn<(payload: unknown, message?: string) => void>();
  const logger = { info, warn } as unknown as PinoLogger;

  const config: ConfigType<typeof agentsConfig> = {
    reconcile: { intervalMs: 40, staleAfterMs: 120_000, batchSize: 50 },
  };

  const withBatchSize = (batchSize: number) =>
    new AgentRunReconciler(
      runs,
      producer,
      { reconcile: { ...config.reconcile, batchSize } },
      logger,
    );

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

    it('reports the tail it abandoned when shutdown interrupts a batch', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({ id: 'run-a' }),
        candidate({ id: 'run-b' }),
        candidate({ id: 'run-c' }),
      ]);
      jobTransportState.mockImplementation(async (_queue, jobId) => {
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

    it('logs only application-owned fields and a fixed reason code', async () => {
      findStaleNonTerminal.mockResolvedValue([
        candidate({ id: 'run-a', status: 'RUNNING', attemptCount: 2 }),
        candidate({ id: 'run-b', status: 'QUEUED', attemptCount: 0 }),
      ]);
      jobTransportState.mockImplementation((_queue, jobId) =>
        Promise.resolve(jobId === 'run-a' ? 'failed' : 'missing'),
      );

      await reconciler.reconcileOnce();

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

      expect(missingWarns).toHaveLength(1);

      const [payload] = missingWarns[0];
      expect(payload).toEqual({
        reason: 'transport_record_missing',
        count: 8,
        runIds: ['run-0', 'run-1', 'run-2', 'run-3', 'run-4'],
      });
    });

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

      reconciler.start();
      await sleep(150);

      expect(findStaleNonTerminal.mock.calls.length).toBeGreaterThan(1);
      expect(publish).not.toHaveBeenCalled();
    });

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

      expect(reconcileTerminalFailure.mock.calls).toEqual([['run-a']]);
      expect(jobTransportState.mock.calls.map(([, jobId]) => jobId)).toEqual([
        'run-a',
        'run-b',
      ]);
    });
  });

  describe('the scan cursor', () => {
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
        Promise.resolve(after === undefined ? stuck : behindThem),
      );
      jobTransportState.mockImplementation((_queue, jobId) =>
        Promise.resolve(jobId === 'genuinely-failed' ? 'failed' : 'missing'),
      );

      const first = await reconciler.reconcileOnce();
      expect(first).toMatchObject({ examined: 3, missing: 3, reconciled: 0 });

      const second = await reconciler.reconcileOnce();

      expect(cursorOnCall(1)).toEqual(cursorOf(stuck[2]));
      expect(reconcileTerminalFailure).toHaveBeenCalledWith('genuinely-failed');
      expect(second).toMatchObject({ examined: 1, failed: 1, reconciled: 1 });
    });

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

      expect(cursorOnCall(1)).toEqual(cursorOf(rows[2]));
    });

    it('carries a cursor forward when a full page comes back', async () => {
      reconciler = withBatchSize(3);

      const rows = page('run-a', 'run-b', 'run-c');
      findStaleNonTerminal.mockResolvedValueOnce(rows).mockResolvedValue([]);

      await reconciler.reconcileOnce();
      await reconciler.reconcileOnce();

      expect(cursorOnCall(0)).toBeUndefined();
      expect(cursorOnCall(1)).toEqual(cursorOf(rows[2]));
    });

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

    it('wraps back to the oldest run immediately after a short page', async () => {
      reconciler = withBatchSize(3);

      const rows = page('run-a', 'run-b');
      findStaleNonTerminal.mockResolvedValueOnce(rows).mockResolvedValue([]);

      await reconciler.reconcileOnce();
      await reconciler.reconcileOnce();

      expect(cursorOnCall(1)).toBeUndefined();
    });

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

      expect([...finalized]).toEqual(['run-a']);

      const second = await reconciler.reconcileOnce();

      expect(cursorOnCall(1)).toEqual(cursorOf(table[0]));
      expect(reconcileTerminalFailure.mock.calls.map(([id]) => id)).toEqual([
        'run-a',
        'run-b', // rejected
        'run-b', // retried
        'run-c',
        'run-d',
      ]);
      expect(finalized.has('run-b')).toBe(true);

      expect(second).toMatchObject({ examined: 3, failed: 3, reconciled: 3 });
    });

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

      expect(cursorOnCall(2)).toEqual(cursorOnCall(1));
      expect(cursorOnCall(2)).toEqual(cursorOf(rows[2]));
    });

    it('starts from the oldest run again after a restart', async () => {
      reconciler = withBatchSize(3);
      findStaleNonTerminal.mockResolvedValue(page('run-a', 'run-b', 'run-c'));

      await reconciler.reconcileOnce();
      expect(cursorOnCall(0)).toBeUndefined();

      const restarted = withBatchSize(3);
      await restarted.reconcileOnce();

      expect(cursorOnCall(1)).toBeUndefined();
    });
  });

  describe('the loop', () => {
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

      await sleep(150);
      expect(findStaleNonTerminal).not.toHaveBeenCalled();
    });

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

    it('returns from stop within its budget even if the pass never settles', async () => {
      let release: (() => void) | undefined;
      findStaleNonTerminal.mockImplementation(
        () =>
          new Promise<Candidate[]>((resolve) => {
            release = () => resolve([]);
          }),
      );

      reconciler.start();
      await sleep(120);
      expect(findStaleNonTerminal).toHaveBeenCalledTimes(1);

      const startedAt = Date.now();
      await reconciler.stop(50);
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(400);

      release?.();
      await sleep(10);
    });
  });
});
