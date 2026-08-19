import { Injectable } from '@nestjs/common';

/**
 * Whether this process is willing to be sent work.
 *
 * Separate from whether its dependencies are healthy, and the distinction is the
 * whole point. A readiness probe answers two different questions at once — "can
 * this process serve?" and "is it being taken out of service?" — and only the
 * second is a decision the process makes about itself. Deriving it from
 * dependency checks alone means a draining instance keeps reporting ready right
 * up until it stops answering, and the load balancer keeps sending it requests
 * that will be cut off mid-flight.
 *
 * Shared by both entrypoints. The API's `/health/ready` reads it; the worker
 * sets it at the same point in its own sequence, so a probe added later reads a
 * flag that was already being maintained correctly rather than one retrofitted
 * around a shutdown path that never considered it.
 */
@Injectable()
export class ProcessReadiness {
  private state: 'starting' | 'ready' | 'draining' = 'starting';

  /**
   * Three states, not a boolean.
   *
   * `starting` and `draining` are both "not ready" to a probe, but they are
   * opposite situations for whoever is watching: one resolves by waiting, the
   * other never will. A boolean makes a rollout that is still coming up
   * indistinguishable from one that is going down.
   */
  get status(): 'starting' | 'ready' | 'draining' {
    return this.state;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  get isDraining(): boolean {
    return this.state === 'draining';
  }

  markReady(): void {
    // Never back to ready from draining. A `SIGTERM` is not retractable, and a
    // process that re-advertised itself mid-drain would be sent work it has
    // already given up the means to finish.
    if (this.state === 'starting') this.state = 'ready';
  }

  markDraining(): void {
    this.state = 'draining';
  }
}
