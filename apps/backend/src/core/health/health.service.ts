import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database';

export type DependencyStatus = {
  status: 'up' | 'down' | 'degraded';
};

export type HealthResult = {
  status: 'ready' | 'ok' | 'error';
  timestamp: string;
  dependencies?: Record<string, DependencyStatus>;
};

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  getLiveness(): HealthResult {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness(): Promise<HealthResult> {
    const dependencies: Record<string, DependencyStatus> = {};
    let isHealthy = true;

    // 1. PostgreSQL Check
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dependencies.postgres = { status: 'up' };
    } catch {
      dependencies.postgres = { status: 'down' };
      isHealthy = false;
    }

    return {
      status: isHealthy ? 'ready' : 'error',
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }
}
