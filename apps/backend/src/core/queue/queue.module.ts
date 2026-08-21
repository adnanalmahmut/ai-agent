import { Module } from '@nestjs/common';

import { QueueProducer } from './queue-producer.service';

/**
 * The queue transport, for processes that actually use one.
 *
 * Not imported by `AppModule`. That omission is the architecture, not an
 * oversight: the API writes an `agent_run` and its `outbox_event` in a single
 * PostgreSQL transaction and returns `202`, so the request path never opens a
 * queue connection and a Redis outage cannot turn a valid `POST` into a 5xx.
 * Everything that talks to BullMQ lives in the worker process.
 *
 * Worker consumption is composed explicitly in `WorkerModule`; this transport
 * module exposes only publication and cannot create a BullMQ worker by itself.
 */
@Module({
  providers: [QueueProducer],
  exports: [QueueProducer],
})
export class QueueModule {}
