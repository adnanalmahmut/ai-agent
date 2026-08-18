import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Queue } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../src/database';
import {
  OutboxDispatcher,
  OutboxRepository,
  ROUTABLE_EVENT_TYPES,
  type ClaimedOutboxEvent,
} from '../src/core/outbox';
import { QueueProducer, QUEUE_NAMES } from '../src/core/queue';

/**
 * The outbox against a real PostgreSQL and a real Redis.
 *
 * Everything asserted below depends on behaviour no mock reproduces:
 * `FOR UPDATE SKIP LOCKED`, `NOW()` evaluated by the database rather than by a
 * worker, `UPDATE ... RETURNING` as one atomic statement, and — the reason this
 * file grew — conditional updates matching a claim version that only the
 * database can hand out. A suite that stubbed the repository would pass while
 * the SQL let a stale dispatcher overwrite a delivered row.
 *
 * Constructed by hand rather than through `AppModule`, because the module the
 * dispatcher belongs to is the *worker's*, and booting the API to test the
 * worker's delivery path would test the wrong wiring.
 */

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6378';

const redis = {
  url: redisUrl,
  keyPrefix: 'outbox-test:',
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 2_000,
  maxRetriesPerRequest: 2,
};

const queue = {
  // Its own namespace, so teardown can obliterate exactly this suite's keys.
  prefix: `outbox-test-${process.pid}`,
  workerConcurrency: 1,
  shutdownGraceMs: 0,
  job: { attempts: 1, backoffMs: 500 },
  retention: {
    // Long enough that nothing is evicted mid-test: the deduplication assertion
    // is only meaningful while the retained job still exists.
    completed: { ageSeconds: 600, count: 100 },
    failed: { ageSeconds: 600, count: 100 },
  },
  outbox: {
    pollIntervalMs: 50,
    batchSize: 10,
    leaseMs: 30_000,
    warnAfterAttempts: 3,
  },
};

const silent = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

const ROUTABLE = 'agent-run.queued';
/** A type this build has no route for — the rolling-deployment case. */
const FUTURE_TYPE = 'agent-run.rescheduled.v2';

describe('transactional outbox (e2e)', () => {
  let prisma: PrismaService;
  let repository: OutboxRepository;
  let inspector: Queue;

  beforeAll(async () => {
    prisma = new PrismaService({
      url: process.env.DATABASE_URL ?? '',
      connectTimeoutMs: 5_000,
    });
    await prisma.onModuleInit();
    repository = new OutboxRepository(prisma);

    inspector = new Queue(QUEUE_NAMES.agentExecution, {
      connection: { url: redisUrl },
      prefix: queue.prefix,
    });
    inspector.on('error', () => undefined);
  }, 60_000);

  afterAll(async () => {
    try {
      await inspector.obliterate({ force: true });
    } catch {
      // Nothing was ever published.
    }
    await inspector.close();
    await prisma.onModuleDestroy();
  });

  afterEach(async () => {
    // Scoped to this table, which nothing outside this suite writes to yet.
    await prisma.outboxEvent.deleteMany({});
    try {
      await inspector.obliterate({ force: true });
    } catch {
      // Nothing to remove.
    }
  });

  const append = async (
    overrides: { type?: string; dedupeKey?: string; payload?: object } = {},
  ): Promise<string> => {
    await repository.append(prisma, {
      type: overrides.type ?? ROUTABLE,
      payload: overrides.payload ?? { agentRunId: 'run-1' },
      dedupeKey: overrides.dedupeKey,
    });

    const row = await prisma.outboxEvent.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return row.id;
  };

  /** The claim shape the dispatcher uses, with this suite's defaults. */
  const claimAs = (
    claimedBy: string,
    overrides: { leaseMs?: number; limit?: number; types?: string[] } = {},
  ) =>
    repository.claim({
      limit: overrides.limit ?? 10,
      leaseMs: overrides.leaseMs ?? 30_000,
      claimedBy,
      types: overrides.types ?? ROUTABLE_EVENT_TYPES,
    });

  const rowOf = (id: string) =>
    prisma.outboxEvent.findUniqueOrThrow({ where: { id } });

  describe('claim', () => {
    it('leases a pending event and counts the attempt', async () => {
      const id = await append({ dedupeKey: 'run-1' });

      const claimed = await claimAs('worker-a');

      expect(claimed).toEqual([
        {
          id,
          type: ROUTABLE,
          payload: { agentRunId: 'run-1' },
          dedupeKey: 'run-1',
          attempts: 1,
          // Returned, not merely written: it is half of the claim version the
          // conditional updates match on.
          claimedBy: 'worker-a',
        },
      ]);

      const row = await rowOf(id);
      expect(row.status).toBe('PROCESSING');
      expect(row.claimedBy).toBe('worker-a');
      expect(row.leaseExpiresAt).not.toBeNull();
      // From the database clock, not the caller's.
      expect(row.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    /**
     * The property that makes a second dispatcher useful rather than merely
     * present. Without `SKIP LOCKED` the two serialise — the second blocks on the
     * first's row locks — and the pair achieves the throughput of one.
     */
    it('hands two concurrent claimants disjoint sets', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 6; i++)
        ids.add(await append({ dedupeKey: `run-${i}` }));

      const [first, second] = await Promise.all([
        claimAs('worker-a', { limit: 3 }),
        claimAs('worker-b', { limit: 3 }),
      ]);

      const claimedIds = [...first, ...second].map((event) => event.id);

      // No id claimed twice, and no id invented.
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      for (const id of claimedIds) expect(ids.has(id)).toBe(true);
    });

    it('leaves a live lease alone', async () => {
      await append();

      await claimAs('worker-a');

      // A second claimant finds nothing: the lease has not lapsed.
      await expect(claimAs('worker-b')).resolves.toEqual([]);
    });

    /**
     * The recovery mechanism itself. A dispatcher that died between publishing
     * and recording delivery leaves the row exactly like this, and the only thing
     * that brings the event back is the lease running out.
     */
    it('reclaims an event whose lease has lapsed, under a new claim version', async () => {
      const id = await append();

      // A lease of zero expires the instant it is written.
      await claimAs('worker-a', { leaseMs: 0 });

      const reclaimed = await claimAs('worker-b');

      expect(reclaimed.map((event) => event.id)).toEqual([id]);
      expect(reclaimed[0]?.attempts).toBe(2);
      expect(reclaimed[0]?.claimedBy).toBe('worker-b');

      expect((await rowOf(id)).claimedBy).toBe('worker-b');
    });

    it('respects a backoff that has not elapsed', async () => {
      const id = await append();
      const [claim] = await claimAs('worker-a');
      await repository.reschedule(claim, 60_000, 'redis unavailable');

      await expect(claimAs('worker-b')).resolves.toEqual([]);

      const row = await rowOf(id);
      expect(row.status).toBe('PENDING');
      expect(row.leaseExpiresAt).toBeNull();
      expect(row.claimedBy).toBeNull();
      expect(row.lastError).toBe('redis unavailable');
      expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('claims an event again once its backoff has elapsed', async () => {
      await append();
      const [claim] = await claimAs('worker-a');
      await repository.reschedule(claim, 0, 'redis unavailable');

      await expect(claimAs('worker-b')).resolves.toHaveLength(1);
    });

    it('never claims a delivered event', async () => {
      const id = await append();
      await claimAs('worker-a', { leaseMs: 0 });
      await repository.markDelivered([id]);

      await expect(claimAs('worker-b')).resolves.toEqual([]);

      const row = await rowOf(id);
      expect(row.status).toBe('DELIVERED');
      expect(row.deliveredAt).not.toBeNull();
      expect(row.leaseExpiresAt).toBeNull();
    });

    /**
     * `FAILED` is terminal. A parked event must not come back on the next pass,
     * or parking it would only have delayed the poison event rather than stopped
     * it.
     */
    it('never claims a parked event, even with an expired lease', async () => {
      await append();
      const [claim] = await claimAs('worker-a', { leaseMs: 0 });
      await repository.markFailed(claim, 'unserialisable payload');

      await expect(claimAs('worker-b')).resolves.toEqual([]);
    });

    it('honours the batch limit', async () => {
      for (let i = 0; i < 5; i++) await append({ dedupeKey: `run-${i}` });

      await expect(claimAs('worker-a', { limit: 2 })).resolves.toHaveLength(2);
    });
  });

  /**
   * Claim ownership, which is what stops a stale dispatcher overwriting a newer
   * outcome.
   *
   * Every test here builds the real interleaving rather than passing forged
   * parameters: dispatcher A claims, its lease expires, dispatcher B reclaims and
   * finishes, and only then does A try to record its own outcome using the claim
   * the database actually gave it.
   */
  describe('stale claim ownership', () => {
    /** Runs the A-claims / lease-expires / B-reclaims prelude. */
    const twoClaims = async (): Promise<{
      id: string;
      stale: ClaimedOutboxEvent;
      current: ClaimedOutboxEvent;
    }> => {
      const id = await append({ dedupeKey: 'ownership' });

      const [stale] = await claimAs('worker-a', { leaseMs: 0 });
      const [current] = await claimAs('worker-b');

      expect(stale).toBeDefined();
      expect(current).toBeDefined();
      // Different claim versions, which is the whole mechanism.
      expect(current.attempts).toBe(stale.attempts + 1);
      expect(current.claimedBy).not.toBe(stale.claimedBy);

      return { id, stale: stale, current: current };
    };

    it('lets the current owner reschedule normally', async () => {
      const { id, current } = await twoClaims();

      await expect(
        repository.reschedule(current, 0, 'redis unavailable'),
      ).resolves.toBe(true);

      const row = await rowOf(id);
      expect(row.status).toBe('PENDING');
      expect(row.lastError).toBe('redis unavailable');
    });

    it('lets the current owner park a permanent failure normally', async () => {
      const { id, current } = await twoClaims();

      await expect(
        repository.markFailed(current, 'Converting circular structure to JSON'),
      ).resolves.toBe(true);

      expect((await rowOf(id)).status).toBe('FAILED');
    });

    /**
     * The first of the two races this iteration exists to close.
     *
     *   A claims                     attempts = 1, claimedBy = A
     *   A's lease expires
     *   B reclaims                   attempts = 2, claimedBy = B
     *   B publishes, records DELIVERED
     *   A's publish finally fails
     *   A reschedules ------------->  the row would go back to PENDING
     *
     * The event would then be published a second time for no reason at all.
     */
    it('refuses a stale reschedule of a delivered event', async () => {
      const { id, stale } = await twoClaims();

      // B finishes the work.
      await repository.markDelivered([id]);

      // A, still holding its old claim, now discovers its publish failed.
      await expect(
        repository.reschedule(stale, 0, 'redis unavailable'),
      ).resolves.toBe(false);

      const row = await rowOf(id);
      expect(row.status).toBe('DELIVERED');
      expect(row.deliveredAt).not.toBeNull();
      // And it is not claimable again, which is the outcome that matters.
      await expect(claimAs('worker-c')).resolves.toEqual([]);
    });

    /**
     * The sharper half of the same race: not a wasted re-delivery but a lie in
     * the audit trail, written by a process that had already lost the right to
     * speak for the row.
     */
    it('refuses a stale park of a delivered event', async () => {
      const { id, stale } = await twoClaims();

      await repository.markDelivered([id]);

      await expect(repository.markFailed(stale, 'gave up')).resolves.toBe(
        false,
      );

      const row = await rowOf(id);
      expect(row.status).toBe('DELIVERED');
      expect(row.lastError).toBeNull();
    });

    /**
     * Ownership is not only about `DELIVERED`. A stale writer must not disturb a
     * *live* claim either, or it would drag work away from the dispatcher that
     * legitimately holds it.
     */
    it('refuses a stale reschedule while another dispatcher is still working', async () => {
      const { id, stale } = await twoClaims();

      await expect(
        repository.reschedule(stale, 60_000, 'redis unavailable'),
      ).resolves.toBe(false);

      const row = await rowOf(id);
      expect(row.status).toBe('PROCESSING');
      expect(row.claimedBy).toBe('worker-b');
    });

    it('refuses a stale park while another dispatcher is still working', async () => {
      const { id, stale } = await twoClaims();

      await expect(repository.markFailed(stale, 'gave up')).resolves.toBe(
        false,
      );

      expect((await rowOf(id)).status).toBe('PROCESSING');
    });

    /**
     * `markDelivered` is deliberately exempt from the ownership check: a
     * successful publish is a fact about Redis, not an opinion, and leaving a
     * genuinely delivered row `PROCESSING` would schedule a re-delivery of work
     * that was already delivered.
     */
    it('still lets a stale dispatcher record a delivery it really performed', async () => {
      const { id } = await twoClaims();

      // A published successfully, just late. Its evidence is admissible.
      await repository.markDelivered([id]);

      expect((await rowOf(id)).status).toBe('DELIVERED');
    });
  });

  /**
   * Rolling deployment. An older worker running beside a newer API must leave
   * event types it has no route for completely alone — claiming one could only
   * end in parking it, destroying work before the newer worker ever started.
   */
  describe('version skew', () => {
    it('does not claim or mutate an event type this build cannot route', async () => {
      const id = await append({ type: FUTURE_TYPE, dedupeKey: 'future' });

      await expect(claimAs('worker-v1')).resolves.toEqual([]);

      const row = await rowOf(id);
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(0);
      expect(row.claimedBy).toBeNull();
      expect(row.lastError).toBeNull();
    });

    it('leaves a future event untouched while claiming the ones it knows', async () => {
      const known = await append({ dedupeKey: 'known' });
      const future = await append({ type: FUTURE_TYPE, dedupeKey: 'future' });

      const claimed = await claimAs('worker-v1');

      expect(claimed.map((event) => event.id)).toEqual([known]);
      expect((await rowOf(future)).attempts).toBe(0);
    });

    /**
     * The half that is easy to get wrong. A worker that skipped a new type while
     * it was `PENDING` but reclaimed it once somebody else's lease lapsed would
     * destroy it just the same, only less often and less reproducibly.
     */
    it('does not reclaim a future event whose lease has lapsed', async () => {
      const id = await append({ type: FUTURE_TYPE, dedupeKey: 'future' });

      // A newer worker claims it and then dies, leaving an expired lease.
      const [claim] = await repository.claim({
        limit: 10,
        leaseMs: 0,
        claimedBy: 'worker-v2',
        types: [FUTURE_TYPE],
      });
      expect(claim).toBeDefined();
      expect((await rowOf(id)).status).toBe('PROCESSING');

      // The old worker must not pick up the pieces.
      await expect(claimAs('worker-v1')).resolves.toEqual([]);
      expect((await rowOf(id)).claimedBy).toBe('worker-v2');
    });

    it('is claimable by a build whose route table includes the type', async () => {
      const id = await append({ type: FUTURE_TYPE, dedupeKey: 'future' });

      const claimed = await repository.claim({
        limit: 10,
        leaseMs: 30_000,
        claimedBy: 'worker-v2',
        types: [...ROUTABLE_EVENT_TYPES, FUTURE_TYPE],
      });

      expect(claimed.map((event) => event.id)).toEqual([id]);
      // Never `FAILED` at any point: version skew delayed it, nothing more.
      expect((await rowOf(id)).status).toBe('PROCESSING');
    });

    it('claims nothing at all when the build has no routes', async () => {
      await append();

      await expect(
        repository.claim({
          limit: 10,
          leaseMs: 30_000,
          claimedBy: 'worker-empty',
          types: [],
        }),
      ).resolves.toEqual([]);
    });
  });

  /**
   * The write side, and the only reason the outbox exists: a rolled-back
   * transaction must leave no event behind. Were the event written outside the
   * transaction, a failed business write would still queue a job — one that
   * refers to a row that never existed.
   */
  describe('append inside a transaction', () => {
    it('commits the event with the transaction', async () => {
      await prisma.$transaction(async (tx) => {
        await repository.append(tx, {
          type: ROUTABLE,
          payload: { agentRunId: 'committed' },
          dedupeKey: 'committed',
        });
      });

      await expect(
        prisma.outboxEvent.count({ where: { dedupeKey: 'committed' } }),
      ).resolves.toBe(1);
    });

    it('discards the event when the transaction rolls back', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await repository.append(tx, {
            type: ROUTABLE,
            payload: { agentRunId: 'rolled-back' },
            dedupeKey: 'rolled-back',
          });

          throw new Error('business write failed');
        }),
      ).rejects.toThrow('business write failed');

      await expect(
        prisma.outboxEvent.count({ where: { dedupeKey: 'rolled-back' } }),
      ).resolves.toBe(0);
    });
  });

  /**
   * PostgreSQL to BullMQ, end to end, with both real.
   *
   * The seam either works or it does not, and every part of it that could be
   * mocked is a part that would not have been tested.
   */
  describe('dispatch', () => {
    let producer: QueueProducer;
    let dispatcher: OutboxDispatcher;

    beforeAll(() => {
      producer = new QueueProducer(redis, queue, silent);
      producer.init();
      dispatcher = new OutboxDispatcher(repository, producer, queue, silent);
    });

    afterAll(async () => {
      await dispatcher.stop(1_000);
      await producer.close();
    });

    it('turns a committed event into a queued job and records delivery', async () => {
      const id = await append({ dedupeKey: 'dispatch-1' });

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({
        claimed: 1,
        delivered: 1,
        deferred: 0,
        failed: 0,
      });

      expect((await rowOf(id)).status).toBe('DELIVERED');

      const job = await inspector.getJob('dispatch-1');
      expect(job?.name).toBe('execute');
      expect(job?.data).toEqual({ agentRunId: 'run-1' });
    }, 30_000);

    it('leaves a future event type for a newer worker instead of parking it', async () => {
      const id = await append({ type: FUTURE_TYPE, dedupeKey: 'future' });

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ claimed: 0, failed: 0 });

      const row = await rowOf(id);
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(0);
    }, 30_000);

    it('reports an empty pass on an empty outbox', async () => {
      await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
        claimed: 0,
        delivered: 0,
        deferred: 0,
        failed: 0,
      });
    }, 30_000);
  });

  /**
   * The crash window, reproduced rather than described.
   *
   * The earlier version of this test claimed twice and asserted the reclaim, but
   * never published anything — so it proved nothing about the window it was named
   * after. This one performs a *real* `queue.add` through the real producer,
   * deliberately skips the `DELIVERED` write, and only then lets the lease lapse.
   * That is exactly the state a dispatcher killed between step two and step three
   * leaves behind.
   */
  describe('crash between publishing and recording delivery', () => {
    let producer: QueueProducer;
    let dispatcher: OutboxDispatcher;

    beforeAll(() => {
      producer = new QueueProducer(redis, queue, silent);
      producer.init();
      dispatcher = new OutboxDispatcher(repository, producer, queue, silent);
    });

    afterAll(async () => {
      await dispatcher.stop(1_000);
      await producer.close();
    });

    it('re-publishes under the same dedupe id and ends DELIVERED exactly once', async () => {
      const id = await append({ dedupeKey: 'crash-window' });

      // --- Dispatcher A: claims, publishes for real, then "crashes". ---
      const [claimA] = await claimAs('dispatcher-a', { leaseMs: 0 });
      expect(claimA).toBeDefined();
      expect(claimA.attempts).toBe(1);

      const publishedByA = await producer.publish(
        QUEUE_NAMES.agentExecution,
        'execute',
        claimA.payload,
        { jobId: claimA.dedupeKey ?? undefined },
      );
      expect(publishedByA.jobId).toBe('crash-window');

      // The job is genuinely in Redis...
      expect(await inspector.getJob('crash-window')).toBeDefined();
      // ...and the database has no idea. `markDelivered` is deliberately never
      // called: this is the crash.
      const afterCrash = await rowOf(id);
      expect(afterCrash.status).toBe('PROCESSING');
      expect(afterCrash.deliveredAt).toBeNull();

      // --- Dispatcher B: the lease has lapsed, so it reclaims and finishes. ---
      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });

      const settled = await rowOf(id);
      expect(settled.status).toBe('DELIVERED');
      expect(settled.deliveredAt).not.toBeNull();
      // Incremented by the reclaim: the durable record shows the event was
      // handled twice, which is what makes at-least-once auditable.
      expect(settled.attempts).toBe(2);

      /**
       * One logical job for the dedupe id, asserted against real queue state.
       *
       * BullMQ returns the same id for a duplicate `add` as for an insert, so
       * there is nothing in the return value to assert on — the queue itself is
       * the only witness. Retention in this suite is long enough that A's job is
       * still present, which is exactly the condition under which the guarantee
       * holds.
       */
      const counts = await inspector.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      );
      const total = Object.values(counts).reduce(
        (sum, value) => sum + (value ?? 0),
        0,
      );
      expect(total).toBe(1);
    }, 30_000);
  });

  /**
   * A prolonged transport outage must not lose durably accepted work.
   *
   * This is what the readiness contract promises: the API stays ready while
   * Redis is down *because* the work is safe in PostgreSQL. The outage is
   * injected by pointing a producer at a closed port, so the failures are real
   * connection failures rather than thrown fakes; recovery swaps in a producer
   * pointed at the working Redis, which is what a Redis coming back looks like
   * from the dispatcher's side.
   */
  describe('recovery after a prolonged outage', () => {
    it('keeps retrying past the old attempt limit and delivers when Redis returns', async () => {
      const id = await append({ dedupeKey: 'outage' });

      // Port 9 is TCP discard: closed, and nothing here ever binds it.
      const brokenProducer = new QueueProducer(
        {
          ...redis,
          url: 'redis://127.0.0.1:9',
          connectTimeoutMs: 150,
          commandTimeoutMs: 150,
        },
        queue,
        silent,
      );
      const failing = new OutboxDispatcher(
        repository,
        brokenProducer,
        // No backoff, so the test can burn through attempts quickly. The retry
        // delay itself is asserted in the unit spec.
        { ...queue, job: { attempts: 1, backoffMs: 0 } },
        silent,
      );

      // Well past the ten attempts the old `OUTBOX_MAX_ATTEMPTS` allowed.
      const ATTEMPTS = 14;
      for (let index = 0; index < ATTEMPTS; index++) {
        const pass = await failing.dispatchOnce();

        expect(pass).toMatchObject({ claimed: 1, delivered: 0, deferred: 1 });
        // Never parked, at any attempt count.
        expect((await rowOf(id)).status).toBe('PENDING');
      }

      const beforeRecovery = await rowOf(id);
      expect(beforeRecovery.attempts).toBe(ATTEMPTS);
      expect(beforeRecovery.status).toBe('PENDING');
      expect(beforeRecovery.lastError).not.toBeNull();

      await brokenProducer.close();

      // --- Redis comes back. ---
      const healthyProducer = new QueueProducer(redis, queue, silent);
      healthyProducer.init();
      const recovered = new OutboxDispatcher(
        repository,
        healthyProducer,
        queue,
        silent,
      );

      try {
        const pass = await recovered.dispatchOnce();

        expect(pass).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });

        const settled = await rowOf(id);
        expect(settled.status).toBe('DELIVERED');
        expect(settled.attempts).toBe(ATTEMPTS + 1);

        // The backlog drained into the real queue.
        expect(await inspector.getJob('outage')).toBeDefined();
      } finally {
        await recovered.stop(1_000);
        await healthyProducer.close();
      }
    }, 120_000);
  });
});
