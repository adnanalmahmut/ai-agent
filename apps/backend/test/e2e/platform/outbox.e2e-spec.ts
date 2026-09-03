import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Queue } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../../src/infrastructure/database';
import {
  OutboxDispatcher,
  OutboxRepository,
  ROUTABLE_EVENT_TYPES,
  type ClaimedOutboxEvent,
} from '../../../src/infrastructure/outbox';
import { QueueProducer, QUEUE_NAMES } from '../../../src/infrastructure/queue';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6378';

const redis = {
  url: redisUrl,
  keyPrefix: 'outbox-test:',
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 2_000,
  maxRetriesPerRequest: 2,
};

const queue = {
  prefix: `outbox-test-${process.pid}`,
  workerConcurrency: 1,
  shutdownGraceMs: 0,
  job: { attempts: 1, backoffMs: 500 },
  retention: {
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
      // The queue may already be absent during test cleanup.
    }
    await inspector.close();
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.outboxEvent.deleteMany({});
  });

  afterEach(async () => {
    await prisma.outboxEvent.deleteMany({});
    try {
      await inspector.obliterate({ force: true });
    } catch {
      // The queue may already be absent during test cleanup.
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
          claimedBy: 'worker-a',
        },
      ]);

      const row = await rowOf(id);
      expect(row.status).toBe('PROCESSING');
      expect(row.claimedBy).toBe('worker-a');
      expect(row.leaseExpiresAt).not.toBeNull();
      expect(row.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('hands two concurrent claimants disjoint sets', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 6; i++)
        ids.add(await append({ dedupeKey: `run-${i}` }));

      const [first, second] = await Promise.all([
        claimAs('worker-a', { limit: 3 }),
        claimAs('worker-b', { limit: 3 }),
      ]);

      const claimedIds = [...first, ...second].map((event) => event.id);

      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      for (const id of claimedIds) expect(ids.has(id)).toBe(true);
    });

    it('leaves a live lease alone', async () => {
      await append();

      await claimAs('worker-a');

      await expect(claimAs('worker-b')).resolves.toEqual([]);
    });

    it('reclaims an event whose lease has lapsed, under a new claim version', async () => {
      const id = await append();

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

  describe('stale claim ownership', () => {
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

    it('refuses a stale reschedule of a delivered event', async () => {
      const { id, stale } = await twoClaims();

      await repository.markDelivered([id]);

      await expect(
        repository.reschedule(stale, 0, 'redis unavailable'),
      ).resolves.toBe(false);

      const row = await rowOf(id);
      expect(row.status).toBe('DELIVERED');
      expect(row.deliveredAt).not.toBeNull();
      await expect(claimAs('worker-c')).resolves.toEqual([]);
    });

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

    it('still lets a stale dispatcher record a delivery it really performed', async () => {
      const { id } = await twoClaims();

      await repository.markDelivered([id]);

      expect((await rowOf(id)).status).toBe('DELIVERED');
    });
  });

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

    it('does not reclaim a future event whose lease has lapsed', async () => {
      const id = await append({ type: FUTURE_TYPE, dedupeKey: 'future' });

      const [claim] = await repository.claim({
        limit: 10,
        leaseMs: 0,
        claimedBy: 'worker-v2',
        types: [FUTURE_TYPE],
      });
      expect(claim).toBeDefined();
      expect((await rowOf(id)).status).toBe('PROCESSING');

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

      expect(await inspector.getJob('crash-window')).toBeDefined();
      const afterCrash = await rowOf(id);
      expect(afterCrash.status).toBe('PROCESSING');
      expect(afterCrash.deliveredAt).toBeNull();

      const pass = await dispatcher.dispatchOnce();

      expect(pass).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });

      const settled = await rowOf(id);
      expect(settled.status).toBe('DELIVERED');
      expect(settled.deliveredAt).not.toBeNull();
      expect(settled.attempts).toBe(2);

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

  describe('recovery after a prolonged outage', () => {
    it('keeps retrying past the old attempt limit and delivers when Redis returns', async () => {
      const id = await append({ dedupeKey: 'outage' });

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
        { ...queue, job: { attempts: 1, backoffMs: 0 } },
        silent,
      );

      const ATTEMPTS = 14;
      for (let index = 0; index < ATTEMPTS; index++) {
        const pass = await failing.dispatchOnce();

        expect(pass).toMatchObject({ claimed: 1, delivered: 0, deferred: 1 });
        expect((await rowOf(id)).status).toBe('PENDING');
      }

      const beforeRecovery = await rowOf(id);
      expect(beforeRecovery.attempts).toBe(ATTEMPTS);
      expect(beforeRecovery.status).toBe('PENDING');
      expect(beforeRecovery.lastError).not.toBeNull();

      await brokenProducer.close();

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

        expect(await inspector.getJob('outage')).toBeDefined();
      } finally {
        await recovered.stop(1_000);
        await healthyProducer.close();
      }
    }, 120_000);
  });
});
