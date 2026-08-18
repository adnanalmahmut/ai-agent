import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database';
import { RedisService } from '../../infrastructure/redis';
import { ProcessReadiness } from '../lifecycle';

export type DependencyStatus = {
  status: 'up' | 'down' | 'degraded' | 'draining';
};

/** Whether a thing the service offers can actually be done right now. */
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

  /**
   * Liveness: is this process running?
   *
   * Touches nothing. Not a simplification — a liveness probe that consults a
   * dependency is actively harmful, because failing it makes the orchestrator
   * *restart the process*. During a database outage that converts one broken
   * dependency into a restart loop across every replica, and the replicas come
   * back to find the database still down. Liveness answers "is this process
   * wedged", and only readiness answers "can it serve".
   */
  getLiveness(): HealthResult {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness: should traffic be sent here?
   *
   * Three inputs, weighted by what the API actually needs to honour a request:
   *
   *   draining    Not ready, whatever the dependencies say. This is the process
   *               reporting a decision about itself, and it is the only input a
   *               dependency check cannot supply.
   *   PostgreSQL  Critical. It is the system of record, and every request path
   *               either reads or writes it. Down means 503.
   *   Redis       Not critical, and this is the interesting one. Accepting
   *               asynchronous work means writing a row and an outbox event in
   *               one transaction; the request path opens no queue connection at
   *               all. So an unreachable Redis delays execution rather than
   *               refusing work, and reporting 503 would take a service that is
   *               still doing its job out of rotation. It is reported as
   *               `degraded` with the queue capability marked alongside, which
   *               tells an operator what is wrong without telling the load
   *               balancer to stop routing.
   *
   * Deliberately absent: any call to an LLM or other external provider. A
   * readiness probe runs every few seconds on every replica, so a provider call
   * here would be a standing bill and a standing outage risk — and a provider
   * being slow says nothing about whether this process can accept a request.
   */
  async getReadiness(): Promise<HealthResult> {
    const timestamp = new Date().toISOString();

    /**
     * Short-circuits before the dependency checks. A draining process should
     * stop being routed to as promptly as possible, and there is nothing a
     * healthy database could say that would change the answer.
     *
     * Only `draining` is checked, not `starting`: Nest serves no route until
     * initialization completes, so a reply from this endpoint is itself proof
     * that startup finished. `starting` exists for the worker, which has no
     * listener to imply the same thing.
     */
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
        /**
         * What an operator actually wants to know: jobs are still being
         * accepted, and they are accumulating in the outbox instead of running.
         * The backlog drains by itself once Redis returns.
         */
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
