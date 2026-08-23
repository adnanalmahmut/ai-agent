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
import { OUTBOX_EVENT_ROUTES, ROUTABLE_EVENT_TYPES } from '../../core/outbox';
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
    // The worker resolves provider credentials at execution time, so its root
    // now parses the master key. Fake, and only for constructing the module.
    process.env.APP_ENCRYPTION_KEY ??=
      'dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU=';

    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  /**
   * Every consumer this process runs, listed exhaustively rather than sampled.
   *
   * A handler registered but not reached by the runner is a queue nothing
   * drains, and a queue the runner opens with no handler is a job that stalls
   * and retries forever. Both are silent, so the assertion is over the whole
   * set — a new handler has to be added here, which is the point.
   */
  it('registers exactly the queues this process consumes', () => {
    const handlers = moduleRef.get<QueueJobHandler[]>(QUEUE_JOB_HANDLERS);
    const runner = moduleRef.get(QueueWorkerRunner);

    const registered = handlers.map(({ queue, jobName }) => ({
      queue,
      jobName,
    }));

    // Order is an artifact of the factory's argument list, not a contract.
    expect(registered).toHaveLength(2);
    expect(registered).toEqual(
      expect.arrayContaining([
        { queue: QUEUE_NAMES.agentExecution, jobName: 'execute' },
        { queue: QUEUE_NAMES.knowledgeEmbedding, jobName: 'embed' },
      ]),
    );

    expect([...runner.queueNames].sort()).toEqual(
      [QUEUE_NAMES.agentExecution, QUEUE_NAMES.knowledgeEmbedding].sort(),
    );
  });

  /**
   * The join between the two halves, which nothing else makes.
   *
   * The route table says where an event is published and each handler
   * separately declares what it consumes. They are unrelated literals, so a
   * queue or job name changed on one side leaves every other test green while
   * production publishes jobs nobody is listening for — which does not fail,
   * it stalls and retries forever while the screen reports the work as done.
   */
  it('registers a handler for every routable event type', () => {
    const handlers = moduleRef.get<QueueJobHandler[]>(QUEUE_JOB_HANDLERS);

    expect(ROUTABLE_EVENT_TYPES.length).toBeGreaterThan(0);

    for (const type of ROUTABLE_EVENT_TYPES) {
      const route = OUTBOX_EVENT_ROUTES[type];

      expect(handlers).toContainEqual(
        expect.objectContaining({
          queue: route.queue,
          jobName: route.jobName,
        }),
      );
    }
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
