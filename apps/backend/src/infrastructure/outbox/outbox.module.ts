import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database';
import { QueueModule } from '../queue';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import { OutboxRepository } from './outbox.repository';

/** The PostgreSQL-only write side, safe to import into an API feature module. */
@Module({
  imports: [DatabaseModule],
  providers: [OutboxRepository],
  exports: [OutboxRepository],
})
export class OutboxPersistenceModule {}

/**
 * The worker-only PostgreSQL-to-BullMQ handoff.
 *
 * Writing an `outbox_event` needs only the persistence module; delivering one
 * needs a queue connection. Keeping that split explicit prevents an API feature
 * that accepts work from gaining queue publication capability by injection.
 */
@Module({
  imports: [OutboxPersistenceModule, QueueModule],
  providers: [OutboxDispatcher],
  exports: [OutboxPersistenceModule, OutboxDispatcher],
})
export class OutboxModule {}
