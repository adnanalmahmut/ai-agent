import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { startWorkerRuntime } from '../../../src/workers/worker.runtime';

function harness() {
  const order: string[] = [];
  const record = (step: string) => () => {
    order.push(step);
  };

  const deps = {
    producer: { init: jest.fn<() => void>(record('producer.init')) },
    runner: { start: jest.fn<() => void>(record('runner.start')) },
    dispatcher: { start: jest.fn<() => void>(record('dispatcher.start')) },
    reconciler: { start: jest.fn<() => void>(record('reconciler.start')) },
  };

  return { deps, order };
}

describe('startWorkerRuntime', () => {
  let context: ReturnType<typeof harness>;

  beforeEach(() => {
    context = harness();
  });

  it('starts every loop the worker process owns', () => {
    startWorkerRuntime(context.deps);

    expect(context.deps.producer.init).toHaveBeenCalledTimes(1);
    expect(context.deps.runner.start).toHaveBeenCalledTimes(1);
    expect(context.deps.dispatcher.start).toHaveBeenCalledTimes(1);
    expect(context.deps.reconciler.start).toHaveBeenCalledTimes(1);
  });

  it('constructs queues, then consumes, then produces, then reconciles', () => {
    startWorkerRuntime(context.deps);

    expect(context.order).toEqual([
      'producer.init',
      'runner.start',
      'dispatcher.start',
      'reconciler.start',
    ]);
  });

  it('starts the reconciler, without which stalled runs are never recovered', () => {
    startWorkerRuntime(context.deps);

    expect(context.deps.reconciler.start).toHaveBeenCalledTimes(1);
    expect(context.order).toContain('reconciler.start');
  });
});
