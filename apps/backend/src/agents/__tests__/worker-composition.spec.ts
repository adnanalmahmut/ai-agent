import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

import {
  QUEUE_JOB_HANDLERS,
  QUEUE_NAMES,
  QueueWorkerRunner,
  type QueueJobHandler,
} from '../../core/queue';
import { WorkerModule } from '../../worker.module';

describe('WorkerModule agent composition', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      'postgresql://test:test@127.0.0.1:5432/test-database';
    process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';

    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('registers the existing agent-execution queue explicitly', () => {
    const handlers = moduleRef.get<QueueJobHandler[]>(QUEUE_JOB_HANDLERS);
    const runner = moduleRef.get(QueueWorkerRunner);

    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatchObject({
      queue: QUEUE_NAMES.agentExecution,
      jobName: 'execute',
    });
    expect(runner.queueNames).toEqual([QUEUE_NAMES.agentExecution]);
  });
});
