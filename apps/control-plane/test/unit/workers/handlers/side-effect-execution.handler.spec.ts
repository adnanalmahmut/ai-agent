import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Job } from 'bullmq';
import { z } from 'zod';

import { AgentDefinitionRegistry } from '../../../../src/ai/agents/agent-definition.registry';
import type { AgentDefinition } from '../../../../src/ai/agents/agent.types';
import { MODEL_IDS } from '../../../../src/ai/models/model-catalog';
import type { ExternalEffectOutcome } from '../../../../src/infrastructure/mail/notification-delivery.port';
import { digestValue } from '../../../../src/ai/tools/digest';
import {
  SIDE_EFFECT_ATTEMPT_FAILED,
  SideEffectExecutionHandler,
} from '../../../../src/workers/handlers/side-effect-execution.handler';
import {
  DeliverApprovedToolEffectUseCase,
  EFFECT_RETRY_WINDOW_MS,
  idempotencyKeyFor,
} from '../../../../src/modules/approvals';
import { ToolAuthorizationService } from '../../../../src/ai/tools/tool-authorization.service';
import type {
  EffectSettlement,
  SideEffectExecutionRow,
} from '../../../../src/ai/tools/tool-execution.service';
import { ToolRegistry } from '../../../../src/ai/tools/tool.registry';
import { APPLICATION_TOOL_DEFINITIONS } from '../../../../src/features/agent-management/tools/definitions';
import {
  SideEffectPreconditionError,
  type PreparedEffect,
  type SideEffectToolImplementation,
} from '../../../../src/ai/tools/tool.types';

const REF = 'notification.send@1';

const agent: AgentDefinition = {
  id: 'handoff-agent',
  version: 1,
  runtime: 'mastra',
  instructions: 'Hand off.',
  model: MODEL_IDS.openAiGpt4oMini,
  modelPolicy: {
    id: 'handoff-agent.model-policy.1',
    allowedModelIds: [MODEL_IDS.openAiGpt4oMini],
  },
  input: z.unknown(),
  output: z.unknown(),
  maxToolGrants: [REF],
};

const input = { recipientMemberId: 'm1', subject: 'S', body: 'B' };

const row = (
  overrides: Partial<SideEffectExecutionRow> = {},
): SideEffectExecutionRow => ({
  id: 'exec_1',
  organizationId: 'org_1',
  agentRunId: 'run_1',
  agentRunAttempt: 1,
  toolId: 'notification.send',
  toolVersion: 1,
  status: 'APPROVED',
  input,
  effectAttemptCount: 0,
  effectFirstAttemptedAt: null,
  effectPayloadDigest: null,
  approval: { status: 'APPROVED', inputDigest: digestValue(input) },
  agentRun: {
    agentId: 'handoff-agent',
    agentVersion: 1,
    organizationAgentVersionId: 'version_1',
  },
  ...overrides,
});

const job = (overrides: Partial<Job> = {}) =>
  ({
    data: { toolExecutionId: 'exec_1', organizationId: 'org_1' },
    opts: { attempts: 3 },
    attemptsMade: 0,
    attemptsStarted: 1,
    ...overrides,
  }) as unknown as Job<{ toolExecutionId: string; organizationId: string }>;

const logger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

describe('SideEffectExecutionHandler', () => {
  let current: SideEffectExecutionRow | null;
  let deliver: jest.Mock<(key: string) => Promise<ExternalEffectOutcome>>;
  let prepare: jest.Mock<() => Promise<PreparedEffect>>;
  let claim: jest.Mock<(...args: unknown[]) => Promise<boolean>>;
  let settle: jest.Mock<
    (id: string, org: string, s: EffectSettlement) => Promise<boolean>
  >;
  let organizationArchivedAt: Date | null | undefined;
  let versionGrants: string[] | null;

  const executions = () => ({
    loadSideEffect: () => Promise.resolve(current),
    claimEffectAttempt: claim,
    settleEffect: settle,
  });

  const prisma = () => ({
    organization: {
      findUnique: () =>
        Promise.resolve(
          organizationArchivedAt === undefined
            ? null
            : { archivedAt: organizationArchivedAt },
        ),
    },
    organizationAgentVersion: {
      findFirst: () =>
        Promise.resolve(
          versionGrants === null ? null : { toolGrants: versionGrants },
        ),
    },
  });

  const implementation = (): SideEffectToolImplementation => ({
    ref: REF,
    kind: 'side_effect',
    propose: () => Promise.resolve(),
    prepareEffect: prepare,
  });

  const handler = (definitions: readonly AgentDefinition[] = [agent]) =>
    new SideEffectExecutionHandler(
      new DeliverApprovedToolEffectUseCase(
        executions() as never,
        new ToolAuthorizationService(
          prisma() as never,
          new ToolRegistry(APPLICATION_TOOL_DEFINITIONS),
          new AgentDefinitionRegistry(definitions),
          [implementation()],
        ),
      ),
      logger as never,
    );

  const settlements = () =>
    settle.mock.calls.map(([, , settlement]) => settlement);

  beforeEach(() => {
    current = row();
    deliver = jest.fn(() =>
      Promise.resolve({
        kind: 'accepted',
        providerMessageId: 'msg_1',
      } as const),
    );
    prepare = jest.fn(() =>
      Promise.resolve({ payloadDigest: 'digest-a', deliver }),
    );
    claim = jest.fn(() => Promise.resolve(true));
    settle = jest.fn(() => Promise.resolve(true));
    organizationArchivedAt = null;
    versionGrants = [REF];
  });

  describe('when nothing may be performed', () => {
    it.each(['SUCCEEDED', 'FAILED', 'REJECTED', 'OUTCOME_UNKNOWN'] as const)(
      'does nothing for a %s execution',
      async (status) => {
        current = row({ status });

        await handler().handle(job());

        expect(deliver).not.toHaveBeenCalled();
        expect(claim).not.toHaveBeenCalled();
        expect(settle).not.toHaveBeenCalled();
      },
    );

    it('never sends for an execution still awaiting approval', async () => {
      current = row({ status: 'AWAITING_APPROVAL' });

      await handler().handle(job());

      expect(deliver).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    });

    it('does nothing for a row the payload tenant does not own', async () => {
      current = null;

      await handler().handle(job());

      expect(deliver).not.toHaveBeenCalled();
    });

    it('refuses a payload without both identifiers', async () => {
      await expect(
        handler().handle(job({ data: { toolExecutionId: 'x' } } as never)),
      ).rejects.toThrow('requires toolExecutionId and organizationId');
    });
  });

  describe('revalidation immediately before the effect', () => {
    it.each([
      [
        'an archived organization',
        () => (organizationArchivedAt = new Date()),
        'precondition_organization',
      ],
      [
        'a missing organization',
        () => (organizationArchivedAt = undefined),
        'precondition_organization',
      ],
      [
        'an approval no longer APPROVED',
        () =>
          (current = row({
            approval: { status: 'PENDING', inputDigest: digestValue(input) },
          })),
        'precondition_approval',
      ],
      [
        'a missing approval row',
        () => (current = row({ approval: null })),
        'precondition_approval',
      ],
      [
        'an input that no longer matches what was approved',
        () => (current = row({ input: { ...input, body: 'rewritten' } })),
        'precondition_approval',
      ],
      [
        'a pinned version that no longer grants the tool',
        () => (versionGrants = []),
        'precondition_authority',
      ],
      [
        'a pinned version that cannot be found',
        () => (versionGrants = null),
        'precondition_authority',
      ],
      [
        'a run with no pinned version',
        () =>
          (current = row({
            agentRun: { ...row().agentRun, organizationAgentVersionId: null },
          })),
        'precondition_authority',
      ],
      [
        'a tool that is not a registered side effect',
        () => (current = row({ toolId: 'knowledge.search', toolVersion: 1 })),
        'precondition_authority',
      ],
    ])(
      'settles FAILED without sending for %s',
      async (_name, arrange, code) => {
        arrange();

        await handler().handle(job());

        expect(deliver).not.toHaveBeenCalled();
        expect(claim).not.toHaveBeenCalled();
        expect(settlements()).toEqual([
          { status: 'FAILED', failureCode: code },
        ]);
      },
    );

    it('settles FAILED when the definition no longer names the tool', async () => {
      await handler([{ ...agent, maxToolGrants: [] }]).handle(job());

      expect(deliver).not.toHaveBeenCalled();
      expect(settlements()).toEqual([
        { status: 'FAILED', failureCode: 'precondition_authority' },
      ]);
    });

    it('settles FAILED when the definition revision is not deployed', async () => {
      await handler([]).handle(job());

      expect(settlements()).toEqual([
        { status: 'FAILED', failureCode: 'precondition_authority' },
      ]);
    });

    it("settles FAILED with the tool's own code when the recipient is gone", async () => {
      prepare.mockRejectedValue(
        new SideEffectPreconditionError('precondition_recipient'),
      );

      await handler().handle(job());

      expect(deliver).not.toHaveBeenCalled();
      expect(settlements()).toEqual([
        { status: 'FAILED', failureCode: 'precondition_recipient' },
      ]);
    });

    it('settles FAILED when the deployment cannot deliver idempotently', async () => {
      prepare.mockRejectedValue(
        new SideEffectPreconditionError('delivery_unsupported'),
      );

      await handler().handle(job());

      expect(claim).not.toHaveBeenCalled();
      expect(settlements()).toEqual([
        { status: 'FAILED', failureCode: 'delivery_unsupported' },
      ]);
    });

    it('retries, reading nothing, when the tool fails for another reason', async () => {
      prepare.mockRejectedValue(
        new Error('postgres://user:hunter2@db timed out'),
      );

      await expect(handler().handle(job())).rejects.toThrow(
        SIDE_EFFECT_ATTEMPT_FAILED,
      );
      expect(settle).not.toHaveBeenCalled();
    });
  });

  describe('the effect', () => {
    it('claims the attempt it read, sends with the derived key, and records success', async () => {
      await handler().handle(job());

      expect(claim).toHaveBeenCalledWith('exec_1', 'org_1', 0, 'digest-a');
      expect(deliver).toHaveBeenCalledWith('notification.send@1:exec_1');
      expect(settlements()).toEqual([
        { status: 'SUCCEEDED', providerMessageId: 'msg_1' },
      ]);
    });

    it('uses the same key on a retry of the same execution', async () => {
      await handler().handle(job());
      current = row({
        effectAttemptCount: 1,
        effectFirstAttemptedAt: new Date(),
        effectPayloadDigest: 'digest-a',
      });
      await handler().handle(job({ attemptsMade: 1 }));

      const keys = deliver.mock.calls.map(([key]) => key);
      expect(keys).toEqual([
        'notification.send@1:exec_1',
        'notification.send@1:exec_1',
      ]);
      expect(claim).toHaveBeenLastCalledWith('exec_1', 'org_1', 1, 'digest-a');
    });

    it('rejects without sending when another delivery holds the attempt', async () => {
      claim.mockResolvedValue(false);

      await expect(handler().handle(job())).rejects.toThrow(
        SIDE_EFFECT_ATTEMPT_FAILED,
      );
      expect(deliver).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    });

    it('records a deterministic provider refusal on a first attempt as FAILED', async () => {
      deliver.mockResolvedValue({ kind: 'rejected' });

      await handler().handle(job());

      expect(settlements()).toEqual([
        { status: 'FAILED', failureCode: 'provider_rejected' },
      ]);
    });

    it('records a provider refusal on a retry as OUTCOME_UNKNOWN', async () => {
      current = row({
        effectAttemptCount: 1,
        effectFirstAttemptedAt: new Date(),
        effectPayloadDigest: 'digest-a',
      });
      deliver.mockResolvedValue({ kind: 'rejected' });

      await handler().handle(job({ attemptsMade: 1 }));

      expect(settlements()).toEqual([{ status: 'OUTCOME_UNKNOWN' }]);
    });

    it('retries an ambiguous outcome while attempts remain', async () => {
      deliver.mockResolvedValue({ kind: 'unavailable' });

      await expect(handler().handle(job({ attemptsMade: 0 }))).rejects.toThrow(
        SIDE_EFFECT_ATTEMPT_FAILED,
      );
      expect(settle).not.toHaveBeenCalled();
    });

    it('records OUTCOME_UNKNOWN, never FAILED, when the last attempt is ambiguous', async () => {
      deliver.mockResolvedValue({ kind: 'unavailable' });

      await handler().handle(
        job({ attemptsMade: 2, opts: { attempts: 3 } } as never),
      );

      expect(settlements()).toEqual([{ status: 'OUTCOME_UNKNOWN' }]);
    });

    it('treats an adapter that throws as an ambiguous outcome', async () => {
      deliver.mockRejectedValue(new Error('re_secret leaked'));

      await handler().handle(
        job({ attemptsMade: 2, opts: { attempts: 3 } } as never),
      );

      expect(settlements()).toEqual([{ status: 'OUTCOME_UNKNOWN' }]);
    });

    it('does not resend when the payload changed after a previous attempt', async () => {
      current = row({
        effectAttemptCount: 1,
        effectFirstAttemptedAt: new Date(),
        effectPayloadDigest: 'digest-before',
      });

      await handler().handle(job({ attemptsMade: 1 }));

      expect(deliver).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(settlements()).toEqual([{ status: 'OUTCOME_UNKNOWN' }]);
    });

    it('does not resend past the provider idempotency window', async () => {
      current = row({
        effectAttemptCount: 1,
        effectFirstAttemptedAt: new Date(
          Date.now() - EFFECT_RETRY_WINDOW_MS - 1_000,
        ),
        effectPayloadDigest: 'digest-a',
      });

      await handler().handle(job({ attemptsMade: 1 }));

      expect(deliver).not.toHaveBeenCalled();
      expect(settlements()).toEqual([{ status: 'OUTCOME_UNKNOWN' }]);
    });

    it('accepts a settlement another delivery already wrote', async () => {
      settle.mockResolvedValue(false);
      current = row();
      const h = handler();
      let reads = 0;
      (
        h as unknown as {
          delivery: {
            executions: {
              loadSideEffect: () => Promise<SideEffectExecutionRow>;
            };
          };
        }
      ).delivery.executions.loadSideEffect = () =>
        Promise.resolve(reads++ === 0 ? row() : row({ status: 'SUCCEEDED' }));

      await expect(h.handle(job())).resolves.toBeUndefined();
    });

    it('rejects when a lost settlement leaves the row non-terminal', async () => {
      settle.mockResolvedValue(false);

      await expect(handler().handle(job())).rejects.toThrow(
        SIDE_EFFECT_ATTEMPT_FAILED,
      );
    });
  });

  describe('log containment', () => {
    const ALLOWED_KEYS = new Set([
      'toolExecutionId',
      'attemptsStarted',
      'attemptsMade',
      'reason',
      'status',
      'failureCode',
    ]);

    const capturing = () => {
      const calls: Record<string, unknown>[] = [];
      const log = {
        setContext: () => undefined,
        info: (fields: Record<string, unknown>) => {
          calls.push(fields);
        },
        warn: (fields: Record<string, unknown>) => {
          calls.push(fields);
        },
      };
      return { calls, log };
    };

    const withLogger = (log: unknown) =>
      new SideEffectExecutionHandler(
        new DeliverApprovedToolEffectUseCase(
          executions() as never,
          new ToolAuthorizationService(
            prisma() as never,
            new ToolRegistry(APPLICATION_TOOL_DEFINITIONS),
            new AgentDefinitionRegistry([agent]),
            [implementation()],
          ),
        ),
        log as never,
      );

    it.each([
      [
        'a recipient gone',
        () =>
          prepare.mockRejectedValue(
            new SideEffectPreconditionError('precondition_recipient'),
          ),
      ],
      [
        'an adapter that throws',
        () =>
          deliver.mockRejectedValue(
            new Error('re_secret leaked sara@example.com'),
          ),
      ],
      [
        'a provider refusal',
        () => deliver.mockResolvedValue({ kind: 'rejected' }),
      ],
      [
        'an ambiguous provider answer',
        () => deliver.mockResolvedValue({ kind: 'unavailable' }),
      ],
      ['a lost claim', () => claim.mockResolvedValue(false)],
    ])('logs only closed fields for %s', async (_name, arrange) => {
      arrange();
      const { calls, log } = capturing();

      await withLogger(log)
        .handle(job({ attemptsMade: 2, opts: { attempts: 3 } } as never))
        .catch(() => undefined);

      expect(calls.length).toBeGreaterThan(0);
      for (const fields of calls) {
        for (const key of Object.keys(fields)) {
          expect(ALLOWED_KEYS.has(key)).toBe(true);
        }
        const serialized = JSON.stringify(fields);
        expect(serialized).not.toContain('sara@example.com');
        expect(serialized).not.toContain('re_secret');
        expect(serialized).not.toContain('digest-a');
        expect(serialized).not.toContain('notification.send@1:exec_1');
      }
    });
  });

  describe('idempotencyKeyFor', () => {
    it('derives the key from the exact action version and the execution', () => {
      expect(
        idempotencyKeyFor({
          id: 'exec_1',
          toolId: 'notification.send',
          toolVersion: 1,
        }),
      ).toBe('notification.send@1:exec_1');
      expect(
        idempotencyKeyFor({
          id: 'exec_1',
          toolId: 'notification.send',
          toolVersion: 2,
        }),
      ).not.toBe(
        idempotencyKeyFor({
          id: 'exec_1',
          toolId: 'notification.send',
          toolVersion: 1,
        }),
      );
    });

    it('stays inside the provider limit for a uuid', () => {
      expect(
        idempotencyKeyFor({
          id: '00000000-0000-4000-8000-000000000000',
          toolId: 'notification.send',
          toolVersion: 1,
        }).length,
      ).toBeLessThanOrEqual(256);
    });
  });
});
