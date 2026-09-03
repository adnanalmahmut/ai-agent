import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../src/api/app.module';
import {
  OUTBOX_EVENT_ROUTES,
  ROUTABLE_EVENT_TYPES,
} from '../../../src/infrastructure/outbox';
import {
  QUEUE_JOB_HANDLERS,
  QUEUE_NAMES,
  QueueModule,
  QueueProducer,
  QueueWorkerRunner,
  type QueueJobHandler,
} from '../../../src/infrastructure/queue';
import {
  KNOWLEDGE_SPACE_SLUGS,
  isKnowledgeSpaceSlug,
} from '../../../src/features/knowledge/knowledge-space.registry';
import { APPLICATION_MODEL_CATALOG } from '../../../src/ai/models/model-catalog';
import { WorkerModule } from '../../../src/workers/worker.module';
import { AgentContextAssembler } from '../../../src/features/knowledge/agent-context.assembler';
import { AgentDefinitionRegistry } from '../../../src/ai/agents/agent-definition.registry';
import { AgentExecutionHandler } from '../../../src/workers/handlers/agent-execution.handler';
import { AgentExecutionModule } from '../../../src/workers/agent-execution.module';
import { AgentRunReconciler } from '../../../src/ai/execution/agent-run-reconciler.service';
import { AgentRunService } from '../../../src/ai/execution/agent-run.service';
import { AgentRunner } from '../../../src/ai/execution/agent-runner.service';
import { AgentRuntimeRegistry } from '../../../src/ai/execution/agent-runtime.registry';
import type { AgentDefinition } from '../../../src/ai/agents/agent.types';
import { AgentsModule } from '../../../src/features/agent-management/agents.module';
import { PRODUCTION_AGENT_DEFINITIONS } from '../../../src/features/content/ideas/agent-definitions';
import {
  CONTENT_IDEA_AGENT_ID,
  CONTENT_IDEA_AGENT_VERSION,
} from '../../../src/features/content/ideas/agent-definitions/content-idea';
import { MastraRuntime } from '../../../src/ai/infrastructure/runtimes/mastra/mastra.runtime';
import { SideEffectExecutionHandler } from '../../../src/workers/handlers/side-effect-execution.handler';
import { ToolGateway } from '../../../src/ai/tools/tool.gateway';

describe('WorkerModule agent composition', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      'postgresql://test:test@127.0.0.1:5432/test-database';
    process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
    process.env.APP_ENCRYPTION_KEY ??=
      'dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU=';
    process.env.APP_ENCRYPTION_ACTIVE_KEY_VERSION ??= 'test-v1';
    process.env.APP_ENCRYPTION_DECRYPT_KEYS ??= '';
    process.env.MAIL_DRIVER ??= 'log';
    process.env.MAIL_FROM_ADDRESS ??= 'no-reply@example.test';

    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('registers exactly the queues this process consumes', () => {
    const handlers = moduleRef.get<QueueJobHandler[]>(QUEUE_JOB_HANDLERS);
    const runner = moduleRef.get(QueueWorkerRunner);

    const registered = handlers.map(({ queue, jobName }) => ({
      queue,
      jobName,
    }));

    expect(registered).toHaveLength(3);
    expect(registered).toEqual(
      expect.arrayContaining([
        { queue: QUEUE_NAMES.agentExecution, jobName: 'execute' },
        { queue: QUEUE_NAMES.knowledgeEmbedding, jobName: 'embed' },
        { queue: QUEUE_NAMES.toolSideEffect, jobName: 'deliver' },
      ]),
    );

    expect([...runner.queueNames].sort()).toEqual(
      [
        QUEUE_NAMES.agentExecution,
        QUEUE_NAMES.knowledgeEmbedding,
        QUEUE_NAMES.toolSideEffect,
      ].sort(),
    );
  });

  it('registers a handler for every routable event type', () => {
    const handlers = moduleRef.get<QueueJobHandler[]>(QUEUE_JOB_HANDLERS);

    expect(ROUTABLE_EVENT_TYPES.length).toBeGreaterThan(0);

    for (const type of ROUTABLE_EVENT_TYPES) {
      const route = OUTBOX_EVENT_ROUTES[type];

      expect(handlers).toContainEqual(
        expect.objectContaining({
          queue: route.queue,
          jobName: route.jobName,
        }),
      );
    }
  });

  it('resolves the reconciler, so the sweep runs in this process', () => {
    expect(moduleRef.get(AgentRunReconciler)).toBeInstanceOf(
      AgentRunReconciler,
    );
  });

  it('can resolve the definition the API accepts runs against', () => {
    const registry = moduleRef.get(AgentDefinitionRegistry);

    expect(
      registry.resolve(CONTENT_IDEA_AGENT_ID, CONTENT_IDEA_AGENT_VERSION),
    ).toMatchObject({
      id: CONTENT_IDEA_AGENT_ID,
      version: CONTENT_IDEA_AGENT_VERSION,
    });
  });

  it('registers only definitions this build can authenticate and run', () => {
    const runtimes = moduleRef.get(AgentRuntimeRegistry);

    expect(PRODUCTION_AGENT_DEFINITIONS.length).toBeGreaterThan(0);

    for (const definition of PRODUCTION_AGENT_DEFINITIONS) {
      expect(() => runtimes.resolve(definition.runtime)).not.toThrow();
      expect(() =>
        APPLICATION_MODEL_CATALOG.agentModel(definition.model),
      ).not.toThrow();
    }
  });

  it('names only knowledge spaces the registry defines', () => {
    const policies = PRODUCTION_AGENT_DEFINITIONS.filter(
      (definition) => definition.contextPolicy !== undefined,
    );

    expect(policies.length).toBeGreaterThan(0);

    for (const definition of policies) {
      const policy = definition.contextPolicy!;

      expect(policy.spaceSlugs.length).toBeGreaterThan(0);

      for (const slug of policy.spaceSlugs) {
        expect(isKnowledgeSpaceSlug(slug)).toBe(true);
        expect(KNOWLEDGE_SPACE_SLUGS).toContain(slug);
      }

      expect(new Set(policy.spaceSlugs).size).toBe(policy.spaceSlugs.length);

      expect(policy.maxChunks).toBeGreaterThan(0);
      expect(policy.maxCharacters).toBeGreaterThan(0);
    }
  });

  it('gives every definition that accepts a result count a contract to enforce it', () => {
    const counting = PRODUCTION_AGENT_DEFINITIONS.filter((definition) =>
      acceptsACount(definition),
    );

    expect(counting.length).toBeGreaterThan(0);

    expect(
      counting.map((definition) => [
        `${definition.id}@${definition.version}`,
        typeof definition.outputContract,
      ]),
    ).toEqual(
      counting.map((definition) => [
        `${definition.id}@${definition.version}`,
        'function',
      ]),
    );
  });
});

function acceptsACount(definition: AgentDefinition): boolean {
  const shape: unknown = (
    definition.input as unknown as { shape?: Record<string, unknown> }
  ).shape;

  if (typeof shape !== 'object' || shape === null) return false;

  return Object.keys(shape).some((field) => COUNT_FIELDS.has(field));
}

const COUNT_FIELDS = new Set(['numberOfIdeas', 'numberOfResults', 'count']);

describe('AppModule agent composition', () => {
  const importsOf = (module: unknown): unknown[] =>
    (Reflect.getMetadata('imports', module as object) as unknown[]) ?? [];

  const unwrap = (entry: unknown): unknown => {
    const wrapper = entry as {
      module?: unknown;
      forwardRef?: () => unknown;
    } | null;

    if (typeof wrapper?.forwardRef === 'function') return wrapper.forwardRef();

    return wrapper?.module ?? entry;
  };

  const providersOf = (root: unknown): Set<unknown> => {
    const seen = new Set<unknown>();
    const providers = new Set<unknown>();
    const queue: unknown[] = [root];

    while (queue.length > 0) {
      const entry = queue.pop();
      const resolved = unwrap(entry);

      if (resolved === undefined || resolved === null) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);

      for (const provider of (Reflect.getMetadata('providers', resolved) ??
        []) as unknown[]) {
        providers.add((provider as { provide?: unknown })?.provide ?? provider);
      }

      for (const imported of importsOf(resolved)) queue.push(imported);
      for (const imported of (entry as { imports?: unknown[] })?.imports ??
        []) {
        queue.push(imported);
      }
    }

    return providers;
  };

  it('imports no queue transport and no worker execution module', () => {
    const imports = importsOf(AppModule);

    expect(imports).toContain(AgentsModule);
    expect(imports).not.toContain(QueueModule);
    expect(imports).not.toContain(AgentExecutionModule);
  });

  it('cannot reach agent execution through any module it imports', () => {
    const seen = new Set<unknown>();
    const queue: unknown[] = [AppModule];

    while (queue.length > 0) {
      const entry = queue.pop();
      const resolved = unwrap(entry);

      if (resolved === undefined || resolved === null) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);

      for (const imported of importsOf(resolved)) queue.push(imported);
      for (const imported of (entry as { imports?: unknown[] })?.imports ??
        []) {
        queue.push(imported);
      }
    }

    expect(seen).toContain(AgentsModule);
    expect(seen).not.toContain(AgentExecutionModule);
    expect(seen).not.toContain(QueueModule);
  });

  it('declares no agent-execution provider anywhere in the API root', () => {
    const seen = new Set<unknown>();
    const providers = new Set<unknown>();
    const queue: unknown[] = [AppModule];

    while (queue.length > 0) {
      const current = queue.pop();
      const resolved = unwrap(current);

      if (resolved === undefined || resolved === null) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);

      for (const provider of (Reflect.getMetadata('providers', resolved) ??
        []) as unknown[]) {
        providers.add((provider as { provide?: unknown })?.provide ?? provider);
      }

      for (const imported of importsOf(resolved)) queue.push(imported);
      for (const imported of (current as { imports?: unknown[] })?.imports ??
        []) {
        queue.push(imported);
      }
    }

    for (const provider of [
      AgentRunner,
      AgentRuntimeRegistry,
      MastraRuntime,
      QueueProducer,
      AgentRunReconciler,
      AgentExecutionHandler,
    ]) {
      expect(providers).not.toContain(provider);
    }

    expect(providers).toContain(AgentRunService);
    expect(providers).toContain(AgentDefinitionRegistry);
  });

  it('executes governed tools in the API, through the same gateway', () => {
    const providers = providersOf(AppModule);

    expect(providers).toContain(ToolGateway);
    expect(providers).toContain(AgentContextAssembler);
  });

  it('cannot deliver or publish a side-effect job from the API', () => {
    const providers = providersOf(AppModule);

    expect(providers).not.toContain(QueueProducer);
    expect(importsOf(AppModule)).not.toContain(QueueModule);

    expect(providers).not.toContain(SideEffectExecutionHandler);
  });

  it('gives the API agent persistence only', () => {
    expect(Reflect.getMetadata('providers', AgentsModule)).toEqual([
      AgentRunService,
    ]);
    expect(importsOf(AgentsModule)).not.toContain(QueueModule);

    for (const provider of [
      QueueProducer,
      AgentRunReconciler,
      AgentExecutionHandler,
    ]) {
      expect(Reflect.getMetadata('providers', AgentsModule)).not.toContain(
        provider,
      );
    }
  });

  it('enforces that ToolExecutionService writers are called only by ToolGateway and SideEffectExecutionHandler', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dirName = path.dirname(fileURLToPath(import.meta.url));
    const srcDir = path.resolve(dirName, '../../../src');
    const writerMethods = [
      'start(',
      'succeed(',
      'fail(',
      'propose(',
      'claimEffectAttempt(',
      'settleEffect(',
      'transition(',
    ];

    const allowedWriters = new Set([
      'tool.gateway.ts',
      'side-effect-execution.handler.ts',
      'tool-execution.service.ts',
    ]);

    const findSourceFiles = async (dir: string): Promise<string[]> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (
            entry.name !== '__tests__' &&
            entry.name !== 'node_modules' &&
            entry.name !== 'dist' &&
            entry.name !== 'generated'
          ) {
            files.push(...(await findSourceFiles(full)));
          }
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts')
        ) {
          files.push(full);
        }
      }

      return files;
    };

    const files = await findSourceFiles(srcDir);
    const violatingFiles: string[] = [];

    for (const file of files) {
      const baseName = path.basename(file);
      if (allowedWriters.has(baseName)) continue;

      const content = await fs.readFile(file, 'utf-8');
      if (
        content.includes('ToolExecutionService') ||
        content.includes('executions.')
      ) {
        for (const method of writerMethods) {
          if (
            content.includes(`.${method}`) &&
            (content.includes('executions') ||
              content.includes('ToolExecutionService'))
          ) {
            violatingFiles.push(`${baseName} calls ${method}`);
          }
        }
      }
    }

    expect(violatingFiles).toEqual([]);
  });
});
