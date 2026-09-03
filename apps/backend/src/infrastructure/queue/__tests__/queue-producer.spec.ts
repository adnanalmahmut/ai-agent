/**
 * The producer's two live surfaces — publishing a job and reading one job's
 * transport state — against a stubbed BullMQ.
 *
 * `bullmq` is mocked wholesale because the class constructs its own `Queue`
 * instances, so there is no seam to inject through and no way to reach these
 * paths without a Redis otherwise. What is under test is entirely this class's
 * own judgement: which BullMQ vocabulary collapses into which application
 * answer, which failures are allowed to reach the caller, and what happens when
 * BullMQ never answers at all.
 */
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { ConfigType } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';

import type { queueConfig, redisConfig } from '../../config';
import { QueuePublishError } from '../queue-publish.error';
import { QUEUE_NAMES } from '../queue.config';
import type { QueueJobTransportState } from '../queue-producer.service';

const add =
  jest.fn<
    (
      name: string,
      data: unknown,
      options: { jobId?: string },
    ) => Promise<{ id?: string }>
  >();
const getJobState = jest.fn<(jobId: string) => Promise<string>>();
const close = jest.fn<() => Promise<void>>();
const on = jest.fn<(event: string, listener: (error: Error) => void) => void>();

const Queue = jest.fn(() => ({ add, getJobState, close, on }));

jest.unstable_mockModule('bullmq', () => ({ Queue }));

let QueueProducer: typeof import('../queue-producer.service').QueueProducer;

beforeAll(async () => {
  ({ QueueProducer } = await import('../queue-producer.service'));
});

/**
 * A 50ms command timeout, which is the bound every `bounded()` call inherits.
 *
 * Short on purpose: the timeout tests below wait for it in real time, and the
 * assertion is only ever that an unanswered call settles, never when.
 */
const redis: ConfigType<typeof redisConfig> = {
  url: 'redis://localhost:6379',
  keyPrefix: 'app:',
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 50,
  maxRetriesPerRequest: 2,
};

const queue: ConfigType<typeof queueConfig> = {
  prefix: 'bmq',
  workerConcurrency: 4,
  shutdownGraceMs: 25_000,
  job: { attempts: 3, backoffMs: 2_000 },
  retention: {
    completed: { ageSeconds: 3_600, count: 1_000 },
    failed: { ageSeconds: 604_800, count: 5_000 },
  },
  outbox: {
    pollIntervalMs: 1_000,
    batchSize: 50,
    leaseMs: 30_000,
    warnAfterAttempts: 10,
  },
};

const name = QUEUE_NAMES.agentExecution;

/** A promise that never settles, standing in for BullMQ mid-reconnect. */
const never = <T>(): Promise<T> => new Promise<T>(() => {});

function harness() {
  const warn = jest.fn<(payload: unknown, message?: string) => void>();
  const logger = { warn } as unknown as PinoLogger;
  const producer = new QueueProducer(redis, queue, logger);

  return { producer, warn };
}

beforeEach(() => {
  Queue.mockClear();
  add.mockReset();
  getJobState.mockReset();
  close.mockReset().mockResolvedValue(undefined);
  on.mockClear();
});

describe('QueueProducer.jobTransportState', () => {
  /**
   * The whole point of the type: BullMQ's state vocabulary reduced to the three
   * answers the reconciler acts on.
   *
   * Collapsing `completed` into `pending` is the deliberate one and the one
   * worth pinning. The caller is asking "has the transport given up on this
   * job?", and for a completed job the answer is no — so returning anything
   * else here would let the reconciler write a terminal failure onto a run
   * whose job actually finished, with the handler's own success write racing
   * it.
   */
  const mapping: ReadonlyArray<[string, QueueJobTransportState]> = [
    ['failed', 'failed'],
    ['unknown', 'missing'],
    ['completed', 'pending'],
    ['active', 'pending'],
    ['waiting', 'pending'],
    ['delayed', 'pending'],
    ['prioritized', 'pending'],
    ['waiting-children', 'pending'],
  ];

  it.each(mapping)('reads BullMQ "%s" as "%s"', async (state, expected) => {
    const { producer } = harness();
    getJobState.mockResolvedValue(state);

    await expect(producer.jobTransportState(name, 'job-1')).resolves.toBe(
      expected,
    );
    expect(getJobState).toHaveBeenCalledWith('job-1');
  });

  /**
   * An outage has to look like an outage. Swallowing this into `'missing'`
   * would tell the reconciler that Redis has forgotten the job, which is its
   * cue to fail the run — turning an unreachable Redis into terminal writes
   * against runs that are still perfectly alive.
   */
  it('lets a transport failure reach the caller instead of answering "missing"', async () => {
    const { producer } = harness();
    getJobState.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(producer.jobTransportState(name, 'job-1')).rejects.toThrow(
      'connect ECONNREFUSED',
    );
  });

  /**
   * The read is bounded, because BullMQ does not bound it.
   *
   * BullMQ resolves every operation against a connection promise that waits for
   * `ready` and does not reject while the client is reconnecting, so an
   * unbounded read during a Redis outage never settles at all — and the
   * reconciler awaits it one candidate at a time, so its whole sweep would stop
   * advancing for the duration of the outage rather than for one interval.
   */
  it('gives up on a read that never answers rather than hanging the sweep', async () => {
    const { producer } = harness();
    getJobState.mockReturnValue(never<string>());

    const error = await producer
      .jobTransportState(name, 'job-1')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QueuePublishError);
    expect(error).toMatchObject({ reason: 'timeout', kind: 'transient' });
    expect((error as QueuePublishError).message).toContain('50ms');
  });

  /**
   * A reader still in flight when the shutdown step runs must not resurrect the
   * transport. `close()` empties the queue map and `queueFor` builds on demand,
   * so without the `closed` guard this call would open a fresh Redis connection
   * during teardown that nothing is left to close — and the process would not
   * exit.
   */
  it('refuses to open a new connection after close', async () => {
    const { producer } = harness();
    producer.init();
    getJobState.mockResolvedValue('active');

    await producer.close();
    const constructedBeforeTheRead = Queue.mock.calls.length;

    const error = await producer
      .jobTransportState(name, 'job-1')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QueuePublishError);
    expect(error).toMatchObject({ reason: 'rejected' });
    expect((error as QueuePublishError).message).toContain('is closed');
    expect(Queue).toHaveBeenCalledTimes(constructedBeforeTheRead);
    expect(getJobState).not.toHaveBeenCalled();
  });
});

describe('QueueProducer.publish', () => {
  it('returns the transport job id for a job the queue accepted', async () => {
    const { producer } = harness();
    add.mockResolvedValue({ id: 'job-1' });

    await expect(
      producer.publish(name, 'execute', { runId: 'run-1' }, { jobId: 'evt-1' }),
    ).resolves.toEqual({ jobId: 'job-1' });

    expect(add).toHaveBeenCalledWith(
      'execute',
      { runId: 'run-1' },
      { jobId: 'evt-1' },
    );
  });

  /**
   * The same bound as the read, asserted separately because the two now share
   * one `bounded()` helper: a refactor that stopped wrapping either call site
   * would leave the other one's test green. Without it the outbox dispatcher
   * stalls behind a single await and accepted work stops being delivered for
   * the whole outage.
   */
  it('fails a publish the queue never answers, so the outbox regains control', async () => {
    const { producer } = harness();
    add.mockReturnValue(never<{ id?: string }>());

    const error = await producer
      .publish(name, 'execute', { runId: 'run-1' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QueuePublishError);
    expect(error).toMatchObject({
      queue: name,
      reason: 'timeout',
      // Transient by definition: a timeout says the queue did not answer, which
      // is a statement about Redis and never about the event, so the dispatcher
      // must keep the event and retry it.
      kind: 'transient',
    });
  });

  /**
   * A rejection is re-typed rather than escaping raw, because the dispatcher
   * branches on `QueuePublishError.kind` to decide whether the event survives.
   */
  it('wraps a rejected publish and classifies it from the underlying error', async () => {
    const { producer } = harness();
    add.mockRejectedValue(new Error('Converting circular structure to JSON'));

    const error = await producer
      .publish(name, 'execute', { runId: 'run-1' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QueuePublishError);
    expect(error).toMatchObject({ reason: 'rejected', kind: 'permanent' });
  });

  it('refuses to publish after close', async () => {
    const { producer } = harness();
    producer.init();
    await producer.close();
    const constructedBeforeThePublish = Queue.mock.calls.length;

    await expect(
      producer.publish(name, 'execute', { runId: 'run-1' }),
    ).rejects.toBeInstanceOf(QueuePublishError);

    expect(add).not.toHaveBeenCalled();
    expect(Queue).toHaveBeenCalledTimes(constructedBeforeThePublish);
  });
});
