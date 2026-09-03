import { Injectable } from '@nestjs/common';

@Injectable()
export class ProcessReadiness {
  private state: 'starting' | 'ready' | 'draining' = 'starting';

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
