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

import type {
  queueConfig,
  redisConfig,
} from '../../../../src/infrastructure/config';
import { QueuePublishError } from '../../../../src/infrastructure/queue/queue-publish.error';
import { QUEUE_NAMES } from '../../../../src/infrastructure/queue/queue.config';
import type { QueueJobTransportState } from '../../../../src/infrastructure/queue/queue-producer.service';

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

let QueueProducer: typeof import('../../../../src/infrastructure/queue/queue-producer.service').QueueProducer;

beforeAll(async () => {
  ({ QueueProducer } =
    await import('../../../../src/infrastructure/queue/queue-producer.service'));
});

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

  it('lets a transport failure reach the caller instead of answering "missing"', async () => {
    const { producer } = harness();
    getJobState.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(producer.jobTransportState(name, 'job-1')).rejects.toThrow(
      'connect ECONNREFUSED',
    );
  });

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
      kind: 'transient',
    });
  });

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
