import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../app.module';
import {
  QUEUE_JOB_HANDLERS,
  QUEUE_NAMES,
  QueueModule,
  QueueProducer,
  QueueWorkerRunner,
  type QueueJobHandler,
} from '../../core/queue';
import { WorkerModule } from '../../worker.module';
import { AgentExecutionHandler } from '../agent-execution.handler';
import { AgentExecutionModule } from '../agent-execution.module';
import { AgentRunReconciler } from '../agent-run-reconciler.service';
import { AgentRunService } from '../agent-run.service';
import { AgentsModule } from '../agents.module';

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

  it('resolves the reconciler, so the sweep runs in this process', () => {
    expect(moduleRef.get(AgentRunReconciler)).toBeInstanceOf(
      AgentRunReconciler,
    );
  });
});

/**
 * The absence half of the composition, asserted statically.
 *
 * Read from module metadata rather than by booting `AppModule`, because booting
 * it needs the full HTTP/auth/mail environment and this assertion is about
 * wiring, not runtime. What it protects is a boundary that is easy to erase by
 * accident: adding `AgentExecutionModule` to `AppModule` to reach one agent
 * service would hand the request path a queue producer and a reconciliation
 * loop, and nothing else in the suite would notice.
 */
describe('AppModule agent composition', () => {
  const importsOf = (module: unknown): unknown[] =>
    (Reflect.getMetadata('imports', module as object) as unknown[]) ?? [];

  it('imports no queue transport and no worker execution module', () => {
    const imports = importsOf(AppModule);

    expect(imports).toContain(AgentsModule);
    expect(imports).not.toContain(QueueModule);
    expect(imports).not.toContain(AgentExecutionModule);
  });

  /**
   * `AgentsModule` is the one agent module the API does get, and it must stay
   * persistence-only: acceptance writes a row and an outbox event, and the
   * dispatcher in the worker turns that into a job. A queue import here would
   * mean a Redis outage could fail a `POST` the database was ready to accept.
   */
  it('gives the API agent persistence only', () => {
    expect(Reflect.getMetadata('providers', AgentsModule)).toEqual([
      AgentRunService,
    ]);
    expect(importsOf(AgentsModule)).not.toContain(QueueModule);

    for (const provider of [
      QueueProducer,
      AgentRunReconciler,
      AgentExecutionHandler,
    ]) {
      expect(Reflect.getMetadata('providers', AgentsModule)).not.toContain(
        provider,
      );
    }
  });
});
