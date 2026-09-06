import { describe, expect, it } from '@jest/globals';

import { AppModule } from '../../../../src/api/app.module';
import { WorkerModule } from '../../../../src/workers/worker.module';
import { ControlPlaneController } from '../../../../src/features/control-plane/control-plane.controller';
import {
  ControlPlaneCoreModule,
  ControlPlaneModule,
} from '../../../../src/features/control-plane/control-plane.module';

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
