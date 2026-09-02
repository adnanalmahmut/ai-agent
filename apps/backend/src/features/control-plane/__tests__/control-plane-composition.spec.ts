import { describe, expect, it } from '@jest/globals';

import { AppModule } from '../../../app.module';
import { WorkerModule } from '../../../workers/worker.module';
import { ControlPlaneController } from '../control-plane.controller';
import {
  ControlPlaneCoreModule,
  ControlPlaneModule,
} from '../control-plane.module';

/**
 * Which composition root gets the HTTP surface, asserted statically.
 *
 * The two modules differ by one line — a `controllers` array — and importing
 * the wrong one into `WorkerModule` compiles, boots, and passes every other
 * test in the repository, because a worker that happens to have a controller
 * registered serves no HTTP and so never exercises it. It would still be a
 * real defect: the worker would answer the operator surface the moment
 * anything gave it a listener, and the "API and worker are separate execution
 * modes" invariant would hold only by accident.
 *
 * Read from module metadata rather than by booting, because booting `AppModule`
 * needs the full HTTP/auth/mail environment and this is a question about wiring.
 */
const importsOf = (module: unknown): unknown[] =>
  (Reflect.getMetadata('imports', module as object) as unknown[]) ?? [];

const controllersOf = (module: unknown): unknown[] =>
  (Reflect.getMetadata('controllers', module as object) as unknown[]) ?? [];

describe('control-plane composition', () => {
  it('gives the worker the providers without the operator surface', () => {
    expect(importsOf(WorkerModule)).toContain(ControlPlaneCoreModule);
    expect(importsOf(WorkerModule)).not.toContain(ControlPlaneModule);
    expect(controllersOf(ControlPlaneCoreModule)).toEqual([]);
  });

  it('gives the API the operator surface', () => {
    expect(importsOf(AppModule)).toContain(ControlPlaneModule);
    expect(controllersOf(ControlPlaneModule)).toEqual([ControlPlaneController]);
  });
});
