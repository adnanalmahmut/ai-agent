import { describe, expect, it } from '@jest/globals';

import { AppModule } from '../../app.module';
import { ControlPlaneCoreModule } from '../../control-plane';
import { WorkerModule } from '../../worker.module';
import { PgVectorKnowledgeRepository } from '../adapters/pgvector.repository';
import { KnowledgeCoreModule } from '../knowledge.module';
import { RETRIEVAL_PORT } from '../ports/retrieval.port';

/**
 * Where the Knowledge domain is wired, and what it does not bring with it.
 *
 * Read from module metadata rather than by booting, because booting either
 * root needs the full environment and these are questions about wiring.
 */
const metadata = (key: string, module: unknown): unknown[] =>
  (Reflect.getMetadata(key, module as object) as unknown[]) ?? [];

describe('knowledge composition', () => {
  it('is available to both execution modes', () => {
    // The worker assembles an agent's context when the run executes; the API
    // needs the same domain for the surfaces that manage it.
    expect(metadata('imports', WorkerModule)).toContain(KnowledgeCoreModule);
    expect(metadata('imports', AppModule)).toContain(KnowledgeCoreModule);
  });

  /**
   * The domain must drag no HTTP surface into the worker — and its own empty
   * `controllers` array is not enough to promise that.
   *
   * It imports `ControlPlaneCoreModule`, whose sibling `ControlPlaneModule`
   * lives in the same file, is exported from the same barrel, differs by four
   * characters, and carries a controller. Swapping one for the other compiles,
   * boots, and passes every other test in the repository, while giving the
   * worker an operator surface. So the whole import graph is walked, not just
   * this module's own metadata.
   */
  it('brings no controller into either root, transitively', () => {
    const seen = new Set<unknown>();
    const controllers: unknown[] = [];

    const walk = (module: unknown): void => {
      // Dynamic modules arrive as `{ module, imports, ... }` rather than as
      // the class, so both shapes are followed.
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
    // Named explicitly as well, so the failure says which import was wrong
    // rather than only that some controller appeared.
    expect(metadata('imports', KnowledgeCoreModule)).toContain(
      ControlPlaneCoreModule,
    );
  });

  /**
   * The port is what features depend on. Binding the concrete repository to
   * the token here is what lets the pgvector adapter be replaced without a
   * caller changing, and a provider list that exported the class instead would
   * quietly make the storage engine part of the domain's public contract.
   */
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
