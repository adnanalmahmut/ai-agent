import { describe, expect, it } from '@jest/globals';

import { AppModule } from '../../../../src/api/app.module';
import { ControlPlaneCoreModule } from '../../../../src/features/control-plane';
import { WorkerModule } from '../../../../src/workers/worker.module';
import { PgVectorKnowledgeRepository } from '../../../../src/features/knowledge/adapters/pgvector.repository';
import {
  KnowledgeCoreModule,
  KnowledgeModule,
} from '../../../../src/features/knowledge/knowledge.module';
import { KnowledgeController } from '../../../../src/features/knowledge/knowledge.controller';
import { RETRIEVAL_PORT } from '../../../../src/features/knowledge/ports/retrieval.port';

const metadata = (key: string, module: unknown): unknown[] =>
  (Reflect.getMetadata(key, module as object) as unknown[]) ?? [];

describe('knowledge composition', () => {
  it('gives the worker the domain without the management surface', () => {
    expect(metadata('imports', WorkerModule)).toContain(KnowledgeCoreModule);
    expect(metadata('imports', WorkerModule)).not.toContain(KnowledgeModule);
  });

  it('gives the API the management surface', () => {
    expect(metadata('imports', AppModule)).toContain(KnowledgeModule);
    expect(metadata('controllers', KnowledgeModule)).toEqual([
      KnowledgeController,
    ]);
  });

  it('brings no controller into either root, transitively', () => {
    const seen = new Set<unknown>();
    const controllers: unknown[] = [];

    const walk = (module: unknown): void => {
      const target =
        module !== null && typeof module === 'object' && 'module' in module
          ? module.module
          : module;

      if (target === null || target === undefined || seen.has(target)) return;
      seen.add(target);

      controllers.push(...metadata('controllers', target));

      for (const imported of metadata('imports', target)) walk(imported);
    };

    walk(KnowledgeCoreModule);

    expect(controllers).toEqual([]);
    expect(metadata('imports', KnowledgeCoreModule)).toContain(
      ControlPlaneCoreModule,
    );
  });

  it('answers the retrieval port with the pgvector adapter', () => {
    const providers = metadata('providers', KnowledgeCoreModule) as {
      provide?: unknown;
      useExisting?: unknown;
    }[];
    const binding = providers.find(
      (provider) => provider.provide === RETRIEVAL_PORT,
    );

    expect(binding?.useExisting).toBe(PgVectorKnowledgeRepository);
    expect(metadata('exports', KnowledgeCoreModule)).not.toContain(
      PgVectorKnowledgeRepository,
    );
  });
});
