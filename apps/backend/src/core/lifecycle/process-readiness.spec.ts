import { beforeEach, describe, expect, it } from '@jest/globals';

import { ProcessReadiness } from './process-readiness';

describe('ProcessReadiness', () => {
  let readiness: ProcessReadiness;

  beforeEach(() => {
    readiness = new ProcessReadiness();
  });

  /**
   * A process that reported ready before it finished starting would be sent
   * traffic it cannot serve — which is the failure a readiness probe exists to
   * prevent, reintroduced by the initial value.
   */
  it('starts not ready', () => {
    expect(readiness.status).toBe('starting');
    expect(readiness.isReady).toBe(false);
    expect(readiness.isDraining).toBe(false);
  });

  it('becomes ready once told', () => {
    readiness.markReady();

    expect(readiness.status).toBe('ready');
    expect(readiness.isReady).toBe(true);
  });

  it('becomes draining once told', () => {
    readiness.markReady();
    readiness.markDraining();

    expect(readiness.status).toBe('draining');
    expect(readiness.isReady).toBe(false);
    expect(readiness.isDraining).toBe(true);
  });

  /**
   * `SIGTERM` is not retractable. A process that re-advertised itself mid-drain
   * would be sent work it has already given up the means to finish — and with
   * a boolean flag that call is a single assignment away.
   */
  it('never returns to ready once draining', () => {
    readiness.markReady();
    readiness.markDraining();
    readiness.markReady();

    expect(readiness.status).toBe('draining');
  });

  it('cannot be revived from draining even if it never became ready', () => {
    readiness.markDraining();
    readiness.markReady();

    expect(readiness.status).toBe('draining');
  });

  /**
   * Both read as "not ready" to a probe, but they are opposite situations for
   * whoever is watching a rollout: one resolves by waiting and the other never
   * will.
   */
  it('distinguishes starting from draining', () => {
    expect(new ProcessReadiness().status).toBe('starting');

    const draining = new ProcessReadiness();
    draining.markDraining();

    expect(draining.status).toBe('draining');
  });
});
