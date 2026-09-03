import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database';
import { QueueModule } from '../queue';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import { OutboxRepository } from './outbox.repository';

@Module({
  imports: [DatabaseModule],
  providers: [OutboxRepository],
  exports: [OutboxRepository],
})
export class OutboxPersistenceModule {}

@Module({
  imports: [OutboxPersistenceModule, QueueModule],
  providers: [OutboxDispatcher],
  exports: [OutboxPersistenceModule, OutboxDispatcher],
})
export class OutboxModule {}
