import { Module } from '@nestjs/common';

import { QueueProducer } from './queue-producer.service';
import { QueueWorkerRunner } from './queue-worker.runner';
import { QUEUE_JOB_HANDLERS } from './queue.constants';

/**
 * The queue transport, for processes that actually use one.
 *
 * Not imported by `AppModule`. That omission is the architecture, not an
 * oversight: the API writes an `agent_run` and its `outbox_event` in a single
 * PostgreSQL transaction and returns `202`, so the request path never opens a
 * queue connection and a Redis outage cannot turn a valid `POST` into a 5xx.
 * Everything that talks to BullMQ lives in the worker process.
 *
 * `QUEUE_JOB_HANDLERS` defaults to empty here so this module is importable
 * without becoming a consumer. The worker module overrides it with the handlers
 * it wants to run; a process that does not override it is structurally
 * incapable of claiming a job.
 */
@Module({
  providers: [
    QueueProducer,
    QueueWorkerRunner,
    { provide: QUEUE_JOB_HANDLERS, useValue: [] },
  ],
  exports: [QueueProducer, QueueWorkerRunner],
})
export class QueueModule {}
