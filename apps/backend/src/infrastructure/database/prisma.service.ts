import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';

import { databaseConfig } from '../config';
import { PrismaClient } from '../../generated/prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    @Inject(databaseConfig.KEY)
    config: ConfigType<typeof databaseConfig>,
  ) {
    const adapter = new PrismaPg({
      connectionString: config.url,
      /**
       * Bounded on purpose; `node-postgres` would otherwise wait forever.
       *
       * An unreachable database must produce failing queries, not hanging ones.
       * Hanging is strictly worse than failing here: the readiness probe meant
       * to report the outage never answers, and a shutdown sequence waiting on
       * an in-flight query never completes — so the process is `SIGKILL`ed
       * rather than stopping.
       */
      connectionTimeoutMillis: config.connectTimeoutMs,
    });

    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
