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
} from '../src/infrastructure/outbox';
import { QueueProducer, QUEUE_NAMES } from '../src/infrastructure/queue';

/**
 * The claim, against a real PostgreSQL.
 *
 * Everything asserted below depends on behaviour no mock reproduces:
 * `FOR UPDATE SKIP LOCKED`, `NOW()` evaluated by the database rather than by a
 * worker, and `UPDATE ... RETURNING` as one atomic statement. A suite that
 * stubbed the repository would pass while the SQL claimed the same row twice.
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
    completed: { ageSeconds: 60, count: 10 },
    failed: { ageSeconds: 60, count: 10 },
  },
  outbox: {
    pollIntervalMs: 50,
    batchSize: 10,
    leaseMs: 30_000,
    maxAttempts: 3,
  },
};

const silent = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

describe('transactional outbox (e2e)', () => {
  let prisma: PrismaService;
  let repository: OutboxRepository;
  let inspector: Queue;

  beforeAll(async () => {
    prisma = new PrismaService({ url: process.env.DATABASE_URL ?? '' });
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
  });

  const append = async (
    overrides: { type?: string; dedupeKey?: string; payload?: object } = {},
  ): Promise<string> => {
    await repository.append(prisma, {
      type: overrides.type ?? 'agent-run.queued',
      payload: overrides.payload ?? { agentRunId: 'run-1' },
      dedupeKey: overrides.dedupeKey,
    });

    const row = await prisma.outboxEvent.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return row.id;
  };

  describe('claim', () => {
    it('leases a pending event and counts the attempt', async () => {
      const id = await append({ dedupeKey: 'run-1' });

      const claimed = await repository.claim(10, 30_000, 'worker-a');

      expect(claimed).toEqual([
        {
          id,
          type: 'agent-run.queued',
          payload: { agentRunId: 'run-1' },
          dedupeKey: 'run-1',
          attempts: 1,
        },
      ]);

      const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
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
        repository.claim(3, 30_000, 'worker-a'),
        repository.claim(3, 30_000, 'worker-b'),
      ]);

      const claimedIds = [...first, ...second].map((event) => event.id);

      // No id claimed twice, and no id invented.
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      for (const id of claimedIds) expect(ids.has(id)).toBe(true);
    });

    it('leaves a live lease alone', async () => {
      await append();

      await repository.claim(10, 30_000, 'worker-a');

      // A second claimant finds nothing: the lease has not lapsed.
      await expect(repository.claim(10, 30_000, 'worker-b')).resolves.toEqual(
        [],
      );
    });

    /**
     * The recovery mechanism itself. A dispatcher that died between publishing
     * and recording delivery leaves the row exactly like this, and the only thing
     * that brings the event back is the lease running out.
     */
    it('reclaims an event whose lease has lapsed', async () => {
      const id = await append();

      // A lease of zero expires the instant it is written.
      await repository.claim(10, 0, 'worker-a');

      const reclaimed = await repository.claim(10, 30_000, 'worker-b');

      expect(reclaimed.map((event) => event.id)).toEqual([id]);
      // Counted again, which is what eventually parks an event that always dies
      // mid-publish rather than retrying it forever.
      expect(reclaimed[0]?.attempts).toBe(2);

      const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      expect(row.claimedBy).toBe('worker-b');
    });

    it('respects a backoff that has not elapsed', async () => {
      const id = await append();
      await repository.claim(10, 30_000, 'worker-a');
      await repository.reschedule(id, 60_000, 'redis unavailable');

      await expect(repository.claim(10, 30_000, 'worker-b')).resolves.toEqual(
        [],
      );

      const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('PENDING');
      expect(row.leaseExpiresAt).toBeNull();
      expect(row.claimedBy).toBeNull();
      expect(row.lastError).toBe('redis unavailable');
      expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('claims an event again once its backoff has elapsed', async () => {
      const id = await append();
      await repository.claim(10, 30_000, 'worker-a');
      await repository.reschedule(id, 0, 'redis unavailable');

      await expect(
        repository.claim(10, 30_000, 'worker-b'),
      ).resolves.toHaveLength(1);
    });

    it('never claims a delivered event', async () => {
      const id = await append();
      await repository.claim(10, 0, 'worker-a');
      await repository.markDelivered([id]);

      await expect(repository.claim(10, 30_000, 'worker-b')).resolves.toEqual(
        [],
      );

      const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
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
      const id = await append();
      await repository.claim(10, 0, 'worker-a');
      await repository.markFailed(id, 'no route');

      await expect(repository.claim(10, 30_000, 'worker-b')).resolves.toEqual(
        [],
      );
    });

    it('honours the batch limit', async () => {
      for (let i = 0; i < 5; i++) await append({ dedupeKey: `run-${i}` });

      await expect(
        repository.claim(2, 30_000, 'worker-a'),
      ).resolves.toHaveLength(2);
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
          type: 'agent-run.queued',
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
            type: 'agent-run.queued',
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
      await dispatcher.stop();
      await producer.close();
    });

    it('turns a committed event into a queued job and records delivery', async () => {
      const id = await append({ dedupeKey: 'dispatch-1' });

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toEqual({
        claimed: 1,
        delivered: 1,
        deferred: 0,
        failed: 0,
      });

      const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('DELIVERED');

      const job = await inspector.getJob('dispatch-1');
      expect(job?.name).toBe('execute');
      expect(job?.data).toEqual({ agentRunId: 'run-1' });
    }, 30_000);

    /**
     * The crash window, replayed deliberately: an event that was published but
     * whose delivery was never recorded is reclaimed and published again. BullMQ
     * collapses the repeat by job id, which is why the duplicate is cheap — but
     * the durable guarantee is the consumer's idempotency, not this.
     */
    it('re-publishes an event left claimed by a dead dispatcher', async () => {
      const id = await append({ dedupeKey: 'dispatch-2' });

      // Exactly the state a dispatcher killed after `queue.add()` leaves behind.
      await repository.claim(10, 0, 'worker-that-died');

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ claimed: 1, delivered: 1 });

      const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('DELIVERED');
      expect(row.attempts).toBe(2);
    }, 30_000);

    it('parks an event whose type has no route', async () => {
      const id = await append({ type: 'agent-run.teleported' });

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ claimed: 1, failed: 1, delivered: 0 });

      const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('FAILED');
      expect(row.lastError).toContain('agent-run.teleported');
    }, 30_000);

    it('reports an empty pass on an empty outbox', async () => {
      await expect(dispatcher.dispatchOnce()).resolves.toEqual({
        claimed: 0,
        delivered: 0,
        deferred: 0,
        failed: 0,
      });
    }, 30_000);
  });
});
