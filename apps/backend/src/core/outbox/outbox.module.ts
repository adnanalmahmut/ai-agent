import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database';
import { QueueModule } from '../queue';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import { OutboxRepository } from './outbox.repository';

/**
 * The PostgreSQL-to-BullMQ handoff.
 *
 * The repository and the dispatcher are separable on purpose. Writing an
 * `outbox_event` needs only the repository and belongs wherever the business
 * transaction is; *delivering* one needs a queue connection and belongs in the
 * worker process. Keeping them in one module but exporting both lets the API
 * import this for the write side without the dispatcher ever being started —
 * `start()` is called by the worker entrypoint and by nothing else.
 */
@Module({
  imports: [DatabaseModule, QueueModule],
  providers: [OutboxRepository, OutboxDispatcher],
  exports: [OutboxRepository, OutboxDispatcher],
})
export class OutboxModule {}
