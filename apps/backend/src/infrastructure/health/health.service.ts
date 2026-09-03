import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database';
import { ProcessReadiness } from '../lifecycle';
import { RedisService } from '../redis';

export type DependencyStatus = {
  status: 'up' | 'down' | 'degraded' | 'draining';
};

export type CapabilityStatus = 'available' | 'degraded';

export type HealthResult = {
  status: 'ready' | 'ok' | 'error';
  timestamp: string;
  dependencies?: Record<string, DependencyStatus>;
  capabilities?: Record<string, CapabilityStatus>;
};

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly readiness: ProcessReadiness,
  ) {}

  getLiveness(): HealthResult {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness(): Promise<HealthResult> {
    const timestamp = new Date().toISOString();

    if (this.readiness.isDraining) {
      return {
        status: 'error',
        timestamp,
        dependencies: { process: { status: 'draining' } },
      };
    }

    const [postgres, redis] = await Promise.all([
      this.probePostgres(),
      this.redis.probe(),
    ]);

    const redisReachable = redis.status === 'up';

    return {
      status: postgres.status === 'up' ? 'ready' : 'error',
      timestamp,
      dependencies: {
        postgres,
        // `degraded`, not `down`, because the word describes this service's
        // ability rather than Redis' own state — and that ability is reduced,
        // not lost.
        redis: { status: redisReachable ? 'up' : 'degraded' },
      },
      capabilities: {
        queue: redisReachable ? 'available' : 'degraded',
      },
    };
  }

  private async probePostgres(): Promise<DependencyStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up' };
    } catch {
      return { status: 'down' };
    }
  }
}
