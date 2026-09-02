import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../app.module';
import { OUTBOX_EVENT_ROUTES, ROUTABLE_EVENT_TYPES } from '../../core/outbox';
import {
  QUEUE_JOB_HANDLERS,
  QUEUE_NAMES,
  QueueModule,
  QueueProducer,
  QueueWorkerRunner,
  type QueueJobHandler,
} from '../../core/queue';
import {
  KNOWLEDGE_SPACE_SLUGS,
  isKnowledgeSpaceSlug,
} from '../../knowledge/knowledge-space.registry';
import { APPLICATION_MODEL_CATALOG } from '../../model-catalog/model-catalog';
import { WorkerModule } from '../../worker.module';
import { AgentContextAssembler } from '../agent-context.assembler';
import { AgentDefinitionRegistry } from '../agent-definition.registry';
import { AgentExecutionHandler } from '../agent-execution.handler';
import { AgentExecutionModule } from '../agent-execution.module';
import { AgentRunReconciler } from '../agent-run-reconciler.service';
import { AgentRunService } from '../agent-run.service';
import { AgentRunner } from '../agent-runner.service';
import { AgentRuntimeRegistry } from '../agent-runtime.registry';
import type { AgentDefinition } from '../agent.types';
import { AgentsModule } from '../agents.module';
import { PRODUCTION_AGENT_DEFINITIONS } from '../definitions';
import {
  CONTENT_IDEA_AGENT_ID,
  CONTENT_IDEA_AGENT_VERSION,
} from '../definitions/content-idea';
import { MastraRuntime } from '../runtime/mastra/mastra.runtime';
import { SideEffectExecutionHandler } from '../tools/side-effect-execution.handler';
import { ToolGateway } from '../tools/tool.gateway';

describe('WorkerModule agent composition', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      'postgresql://test:test@127.0.0.1:5432/test-database';
    process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
    // The worker resolves provider credentials at execution time, so its root
    // now parses the master key. Fake, and only for constructing the module.
    process.env.APP_ENCRYPTION_KEY ??=
      'dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU=';
    process.env.APP_ENCRYPTION_ACTIVE_KEY_VERSION ??= 'test-v1';
    process.env.APP_ENCRYPTION_DECRYPT_KEYS ??= '';
    // The worker now composes the mail driver for approved notifications, so
    // its root parses the same variables the API does. `log` sends nothing.
    process.env.MAIL_DRIVER ??= 'log';
    process.env.MAIL_FROM_ADDRESS ??= 'no-reply@example.test';

    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  /**
   * Every consumer this process runs, listed exhaustively rather than sampled.
   *
   * A handler registered but not reached by the runner is a queue nothing
   * drains, and a queue the runner opens with no handler is a job that stalls
   * and retries forever. Both are silent, so the assertion is over the whole
   * set — a new handler has to be added here, which is the point.
   */
  it('registers exactly the queues this process consumes', () => {
    const handlers = moduleRef.get<QueueJobHandler[]>(QUEUE_JOB_HANDLERS);
    const runner = moduleRef.get(QueueWorkerRunner);

    const registered = handlers.map(({ queue, jobName }) => ({
      queue,
      jobName,
    }));

    // Order is an artifact of the factory's argument list, not a contract.
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

  /**
   * The join between the two halves, which nothing else makes.
   *
   * The route table says where an event is published and each handler
   * separately declares what it consumes. They are unrelated literals, so a
   * queue or job name changed on one side leaves every other test green while
   * production publishes jobs nobody is listening for — which does not fail,
   * it stalls and retries forever while the screen reports the work as done.
   */
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

  /**
   * The other unrelated-literals join in this subsystem.
   *
   * The API pins `(CONTENT_IDEA_AGENT_ID, CONTENT_IDEA_AGENT_VERSION)` onto
   * every run it accepts; the worker resolves that pair out of a separately
   * written array. Dropping the definition from the array, or bumping the
   * version constant without registering the new one, leaves acceptance
   * answering `202` and every run failing in the worker as an unregistered
   * pair — the exact shape of failure the queue/route assertion above exists
   * to prevent, on a path nothing was watching.
   */
  it('can resolve the definition the API accepts runs against', () => {
    const registry = moduleRef.get(AgentDefinitionRegistry);

    expect(
      registry.resolve(CONTENT_IDEA_AGENT_ID, CONTENT_IDEA_AGENT_VERSION),
    ).toMatchObject({
      id: CONTENT_IDEA_AGENT_ID,
      version: CONTENT_IDEA_AGENT_VERSION,
    });
  });

  /**
   * Every registered definition must be runnable by this build.
   *
   * A definition naming an unknown or capability-incompatible catalog model
   * fails deterministically before a provider call rather than after a run has
   * been accepted and a caller is waiting.
   */
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

  /**
   * Every space a definition claims to read must exist in the taxonomy.
   *
   * The compiler already enforces this — `ContextPolicy.spaceSlugs` is typed as
   * `KnowledgeSpaceSlug[]` — and this asserts it again at runtime for the one
   * case the compiler cannot see: a definition constructed through a cast, or
   * one whose slug was correct when written and whose registry entry has since
   * been removed in a change that used `as` to make the file compile.
   *
   * The failure mode it guards is silent, which is why it is worth a second
   * check. A policy naming a slug nothing resolves is not an error at runtime:
   * `resolveSlugs` returns nothing, the assembler returns no passages, and the
   * agent answers ungrounded — indistinguishable from an organization that has
   * stored nothing. Nobody reports it, because the feature appears to work.
   */
  it('names only knowledge spaces the registry defines', () => {
    const policies = PRODUCTION_AGENT_DEFINITIONS.filter(
      (definition) => definition.contextPolicy !== undefined,
    );

    // Not vacuous: at least one shipped definition actually reads knowledge.
    expect(policies.length).toBeGreaterThan(0);

    for (const definition of policies) {
      const policy = definition.contextPolicy!;

      expect(policy.spaceSlugs.length).toBeGreaterThan(0);

      for (const slug of policy.spaceSlugs) {
        expect(isKnowledgeSpaceSlug(slug)).toBe(true);
        expect(KNOWLEDGE_SPACE_SLUGS).toContain(slug);
      }

      // A policy naming one space twice retrieves nothing extra and reads as a
      // wider grant than it is.
      expect(new Set(policy.spaceSlugs).size).toBe(policy.spaceSlugs.length);

      // Both budgets bind, and neither is zero — a policy that declared spaces
      // and a budget of nothing would resolve them and then discard every
      // passage, which is the same silent emptiness in a different place.
      expect(policy.maxChunks).toBeGreaterThan(0);
      expect(policy.maxCharacters).toBeGreaterThan(0);
    }
  });

  /**
   * A definition that promises a *number* of results carries the contract that
   * enforces it.
   *
   * The count is what a caller is billed against, and a schema cannot check it
   * — it never sees the request. So the enforcement lives in an optional field,
   * and an optional field is one that can be dropped in a refactor or forgotten
   * on the next agent. The eval suite would catch it being unwired from
   * `content-idea@1`; nothing would catch a second counting agent shipping
   * without one, which is what this covers.
   *
   * A count field is recognised by asking the input schema, not by naming
   * definitions here — a list restated in a test agrees with itself forever.
   */
  it('gives every definition that accepts a result count a contract to enforce it', () => {
    const counting = PRODUCTION_AGENT_DEFINITIONS.filter((definition) =>
      acceptsACount(definition),
    );

    // Not vacuous: at least one shipped definition takes a count.
    expect(counting.length).toBeGreaterThan(0);

    // The pair, so a failure names which definition is missing one.
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

/**
 * Whether a definition's input schema has a field naming how many results are
 * wanted.
 *
 * Asked of the schema by parsing a probe, so it stays true of a definition
 * nobody thought to add to a list. A schema that accepts the probe *without*
 * the count field and rejects it *with* one does not take a count; the reverse
 * does.
 */
function acceptsACount(definition: AgentDefinition): boolean {
  const shape: unknown = (
    definition.input as unknown as { shape?: Record<string, unknown> }
  ).shape;

  if (typeof shape !== 'object' || shape === null) return false;

  return Object.keys(shape).some((field) => COUNT_FIELDS.has(field));
}

/**
 * The field names that mean "how many results". One today; listed rather than
 * pattern-matched so adding a synonym is a deliberate edit.
 */
const COUNT_FIELDS = new Set(['numberOfIdeas', 'numberOfResults', 'count']);

/**
 * The absence half of the composition, asserted statically.
 *
 * Read from module metadata rather than by booting `AppModule`, because booting
 * it needs the full HTTP/auth/mail environment and this assertion is about
 * wiring, not runtime. What it protects is a boundary that is easy to erase by
 * accident: adding `AgentExecutionModule` to `AppModule` to reach one agent
 * service would hand the request path a queue producer and a reconciliation
 * loop, and nothing else in the suite would notice.
 */
describe('AppModule agent composition', () => {
  const importsOf = (module: unknown): unknown[] =>
    (Reflect.getMetadata('imports', module as object) as unknown[]) ?? [];

  /**
   * An import entry is a class, a dynamic module `{ module, imports }`, or a
   * `forwardRef`'s `{ forwardRef }` thunk. Unwrapped so none of the three can
   * hide a subtree from the walks below.
   */
  const unwrap = (entry: unknown): unknown => {
    const wrapper = entry as {
      module?: unknown;
      forwardRef?: () => unknown;
    } | null;

    if (typeof wrapper?.forwardRef === 'function') return wrapper.forwardRef();

    return wrapper?.module ?? entry;
  };

  /** Every provider token in a module's transitive import closure. */
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

  /**
   * The same boundary, but transitively — which is the only version of it that
   * holds now that the API has a feature module in front of the agent.
   *
   * The assertion above reads `AppModule`'s own import list, so it says
   * nothing about what those imports import. `ContentIdeaModule` is the module
   * that would want a runner: someone adding `AgentExecutionModule` to *it* to
   * run an agent on the request thread passes every static check here and
   * every e2e test, because the e2e harness boots with Redis available. What
   * the request path would actually gain is a queue producer, a reconciliation
   * loop, and a runner that drives a model generation on the request thread.
   *
   * Spending a provider credential inside an HTTP handler is deliberately not
   * the line any more, and the MCP adapter is why. Under MCP the caller is the
   * runtime: a tool call arrives as a request and has to be answered before the
   * response is written, so `knowledge.search@1` — an embedding and a vector
   * search — now runs in the API by design, and `docs/architecture.md` records
   * that decision. What must stay out is the machinery for *executing a
   * definition*: the runner, the runtimes, the queue producer, and the
   * reconciler.
   */
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
      // A dynamic module carries its own imports beside the class it names.
      for (const imported of (entry as { imports?: unknown[] })?.imports ??
        []) {
        queue.push(imported);
      }
    }

    expect(seen).toContain(AgentsModule);
    expect(seen).not.toContain(AgentExecutionModule);
    expect(seen).not.toContain(QueueModule);
  });

  /**
   * And the providers themselves, not only the modules that carry them. A
   * future module that declared `AgentRunner` directly rather than importing
   * `AgentExecutionModule` would slip past the closure walk above.
   */
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

    // Not vacuous: the API owns run persistence and the code-definition
    // registry used to validate organization installation configuration. It
    // still owns no execution runtime, queue producer, runner, or handler.
    expect(providers).toContain(AgentRunService);
    expect(providers).toContain(AgentDefinitionRegistry);
  });

  /**
   * The API now executes governed tools, and that is a deliberate change.
   *
   * Under Mastra a tool call happens inside the worker, because the runtime
   * runs there. Under MCP the caller *is* the runtime: an external client
   * sends `tools/call` over HTTP and the answer has to be produced before the
   * response is written. There is no version of that in which the work happens
   * elsewhere — routing it to the worker would mean a synchronous
   * request/response over a queue, which is a worse system than the one this
   * replaces.
   *
   * So `ToolGateway` and the context assembler it needs are legitimately in
   * the API root, and this asserts it rather than leaving it to look like
   * drift. What has *not* changed is who decides: the same gateway, the same
   * registry, the same durable `ToolExecution` rows.
   */
  it('executes governed tools in the API, through the same gateway', () => {
    const providers = providersOf(AppModule);

    expect(providers).toContain(ToolGateway);
    expect(providers).toContain(AgentContextAssembler);
  });

  /**
   * And the reason the worker's side-effect consumer being reachable here is
   * inert rather than a second delivery path.
   *
   * `AgentToolsModule` is shared, so the API root does construct
   * `SideEffectExecutionHandler` — its dependencies, the tool implementations
   * and the registry, are exactly the ones that must not be exported to
   * anybody, so moving it out would mean widening the module's surface to the
   * raw implementations that *can* perform an effect directly. Keeping it and
   * proving it unreachable is the stronger arrangement.
   *
   * Unreachable in both directions, which is what this asserts. Nothing can
   * deliver a job to it, because the API imports no queue transport and so
   * registers no consumer. Nothing can publish one either, because the API has
   * no `QueueProducer`. The only thing that ever enqueues an approved action
   * is the outbox dispatcher, and that runs in the worker.
   */
  it('cannot deliver or publish a side-effect job from the API', () => {
    const providers = providersOf(AppModule);

    expect(providers).not.toContain(QueueProducer);
    expect(importsOf(AppModule)).not.toContain(QueueModule);

    // The handler is present but has no transport on either side of it.
    expect(providers).toContain(SideEffectExecutionHandler);
  });

  /**
   * `AgentsModule` is the one agent module the API does get, and it must stay
   * persistence-only: acceptance writes a row and an outbox event, and the
   * dispatcher in the worker turns that into a job. A queue import here would
   * mean a Redis outage could fail a `POST` the database was ready to accept.
   */
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

  /**
   * ToolExecutionService writer boundary.
   *
   * As declared in AgentToolsModule: ToolExecutionService is exported for one
   * read (`countForRun`), not for its writers. The lifecycle writers —
   * `start`, `succeed`, `fail`, `propose`, `claimEffectAttempt`,
   * `settleEffect`, `transition` — stay callable only from ToolGateway and
   * SideEffectExecutionHandler.
   */
  it('enforces that ToolExecutionService writers are called only by ToolGateway and SideEffectExecutionHandler', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dirName = path.dirname(fileURLToPath(import.meta.url));
    const srcDir = path.resolve(dirName, '../..');
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
