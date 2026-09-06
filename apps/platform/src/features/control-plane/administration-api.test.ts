import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_PATH, CONTROL_PLANE_PATH } from '@/config/paths';
import {
  ApiError,
  clearFeatureFlag,
  deactivateSelfAccount,
  deactivateUserAccount,
  restoreUserAccount,
  errorDetailLines,
  listControlPlaneAudit,
  listFeatureFlags,
  listManagedSecrets,
  listRuntimeSettings,
  removeManagedSecret,
  setFeatureFlag,
  setManagedSecret,
  setRuntimeSetting,
  type AccountLifecycleResult,
  type ControlPlaneAuditEntry,
  type FeatureFlagState,
  type ManagedSecretDescription,
  type RuntimeSettingState,
} from '@/lib/application-api';
import {
  approveAgentAction,
  getAgentActionApproval,
  listAgentActionApprovals,
  rejectAgentAction,
  AGENT_ACTION_APPROVAL_STATUSES,
  TOOL_EXECUTION_STATUSES,
  TOOL_FAILURE_CODES,
  type AgentActionApproval,
} from '@/features/organization/organization-api';

/**
 * The approvals and platform-administration wire contract, read from the
 * requests these functions make and the bodies they accept.
 *
 * Every type here is an alias of the generated OpenAPI contract, which the
 * Backend authors as Zod and
 * `apps/backend/test/unit/infrastructure/docs/administration-contract.spec.ts`
 * pins from the producing side. These are the same payloads read from the
 * consuming one.
 */

const ORGANIZATION = 'org_1';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const answers = (data: unknown, status = 200) => {
  fetchMock.mockResolvedValue(
    jsonResponse(
      { success: true, data, meta: { requestId: 'r', timestamp: 't' } },
      status,
    ),
  );
};

const requested = () => {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init };
};

const FLAG: FeatureFlagState = {
  key: 'agents.enabled',
  description: 'Whether agents may run at all',
  enabled: true,
  source: 'default',
  defaultEnabled: true,
  organizationOverridable: true,
};

const SETTING: RuntimeSettingState = {
  key: 'agents.max_concurrent_runs_per_organization',
  description: 'How many runs one organization may have in flight',
  value: 3,
  isDefault: true,
  storedValueRejected: false,
  defaultValue: 3,
  sensitivity: 'public',
  editable: true,
};

const SECRET: ManagedSecretDescription = {
  key: 'openai.api_key',
  description: 'The OpenAI credential',
  configured: true,
  label: 'production',
  algorithm: 'aes-256-gcm',
  keyVersion: 'v1',
  lastRotatedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  usable: true,
};

const AUDIT_ENTRY: ControlPlaneAuditEntry = {
  id: 'evt_1',
  occurredAt: '2026-01-01T00:00:00.000Z',
  actorUserId: 'user_1',
  resource: 'featureFlag',
  action: 'featureFlag.setPlatformOverride',
  resourceKey: 'agents.enabled',
  organizationId: null,
  before: null,
  after: { kind: 'featureFlagOverride', enabled: true },
};

const LIFECYCLE: AccountLifecycleResult = {
  userId: 'user_1',
  deletedAt: '2026-01-01T00:00:00.000Z',
  revokedSessions: 3,
};

const APPROVAL: AgentActionApproval = {
  toolExecutionId: 'exec_1',
  organizationId: ORGANIZATION,
  agentRunId: 'run_1',
  agentId: 'content-idea',
  agentVersion: 1,
  toolId: 'notification.send',
  toolVersion: 1,
  executionStatus: 'AWAITING_APPROVAL',
  approval: {
    status: 'PENDING',
    requestedAt: '2026-01-01T00:00:00.000Z',
    decidedAt: null,
    decidedByUserId: null,
    decisionNote: null,
  },
  proposal: {
    kind: 'notification.send@1',
    recipient: { memberId: 'mem_1', name: 'A Person', email: 'a@example.test' },
    subject: 'A subject',
    body: 'A body',
  },
  effect: {
    attemptCount: 0,
    firstAttemptedAt: null,
    completedAt: null,
    failureCode: null,
  },
};

describe('feature flags', () => {
  it('reads a flag that has no override at all', async () => {
    answers([FLAG]);

    const [flag] = await listFeatureFlags();

    expect(flag.source).toBe('default');
    // Never overridden is an absent key, not a null one.
    expect(flag.platformOverride).toBeUndefined();
    expect(requested().url).toBe(`${API_BASE_PATH}${CONTROL_PLANE_PATH}/feature-flags`);
  });

  it('sets and clears an override on the same slot', async () => {
    answers({ ...FLAG, enabled: false, source: 'platform', platformOverride: false });

    await setFeatureFlag('agents.enabled', false);
    const set = requested();

    expect(set.url).toBe(`${API_BASE_PATH}${CONTROL_PLANE_PATH}/feature-flags/agents.enabled`);
    expect(set.init.method).toBe('PUT');
    expect(JSON.parse(String(set.init.body))).toEqual({ enabled: false });

    fetchMock.mockReset();
    answers(FLAG);

    await clearFeatureFlag('agents.enabled');

    expect(requested().init.method).toBe('DELETE');
  });
});

describe('runtime settings', () => {
  it('reads a setting and the value it falls back to', async () => {
    answers([SETTING]);

    const [setting] = await listRuntimeSettings();

    expect(setting.isDefault).toBe(true);
    expect(setting.sensitivity).toBe('public');
    expect(requested().url).toBe(`${API_BASE_PATH}${CONTROL_PLANE_PATH}/settings`);
  });

  it('sends a value the contract deliberately does not constrain', async () => {
    answers({ ...SETTING, value: 7, isDefault: false });

    await setRuntimeSetting(
      'agents.max_concurrent_runs_per_organization',
      7,
    );

    expect(JSON.parse(String(requested().init.body))).toEqual({ value: 7 });
  });
});

describe('managed secrets stay write-only', () => {
  it('sends the credential', async () => {
    answers(SECRET);

    await setManagedSecret('openai.api_key', 'sk-secret-value', 'production');

    const { url, init } = requested();

    expect(url).toBe(`${API_BASE_PATH}${CONTROL_PLANE_PATH}/secrets/openai.api_key`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      value: 'sk-secret-value',
      label: 'production',
    });
  });

  it('is answered with metadata and nothing else', async () => {
    answers([SECRET]);

    const [secret] = await listManagedSecrets();

    expect(Object.keys(secret)).toEqual([
      'key',
      'description',
      'configured',
      'label',
      'algorithm',
      'keyVersion',
      'lastRotatedAt',
      'updatedAt',
      'usable',
    ]);
  });

  /*
   * The type carries no credential, so a screen cannot read one even if a
   * server sent one. This states that from the consuming side: the fixture is
   * the whole contract, and none of these names is in it.
   */
  it.each([
    'value',
    'secret',
    'plaintext',
    'ciphertext',
    'encrypted',
    'credential',
    'apiKey',
    'token',
  ])('never answers with a field named %s', (forbidden) => {
    expect(Object.keys(SECRET)).not.toContain(forbidden);
  });

  it('says a slot is filled but unreadable without revealing why', async () => {
    answers([{ ...SECRET, usable: false }]);

    const [secret] = await listManagedSecrets();

    expect(secret.configured).toBe(true);
    expect(secret.usable).toBe(false);
  });

  it('removes a slot', async () => {
    answers({ ...SECRET, configured: false, usable: false });

    await removeManagedSecret('openai.api_key');

    expect(requested().init.method).toBe('DELETE');
  });
});

describe('audit', () => {
  it('asks for the first page with no query at all', async () => {
    answers({ items: [AUDIT_ENTRY], nextCursor: 'cursor_2' });

    const page = await listControlPlaneAudit();

    expect(page.nextCursor).toBe('cursor_2');
    expect(requested().url).toBe(`${API_BASE_PATH}${CONTROL_PLANE_PATH}/audit`);
  });

  it('carries a cursor and a limit, and reads a final page', async () => {
    answers({ items: [AUDIT_ENTRY], nextCursor: null });

    const page = await listControlPlaneAudit({ cursor: 'cursor_2', limit: 10 });

    expect(page.nextCursor).toBeNull();
    expect(requested().url).toBe(
      `${API_BASE_PATH}${CONTROL_PLANE_PATH}/audit?cursor=cursor_2&limit=10`,
    );
  });

  it('reads an entry written by a release that named things differently', async () => {
    // `action` is a stored string, not a vocabulary, so an unknown one has to
    // arrive intact rather than be refused or reshaped.
    answers({
      items: [{ ...AUDIT_ENTRY, action: 'somethingElse.happened' }],
      nextCursor: null,
    });

    const page = await listControlPlaneAudit();

    expect(page.items[0].action).toBe('somethingElse.happened');
  });
});

describe('approvals', () => {
  it('lists a page, filtered by decision state', async () => {
    answers({ items: [APPROVAL], nextCursor: null });

    await listAgentActionApprovals(ORGANIZATION, {
      status: 'PENDING',
      limit: 10,
    });

    expect(requested().url).toBe(
      `${API_BASE_PATH}/organizations/${ORGANIZATION}/agent-action-approvals?status=PENDING&limit=10`,
    );
  });

  it('reads one proposed action with its recipient', async () => {
    answers(APPROVAL);

    const approval = await getAgentActionApproval(ORGANIZATION, 'exec_1');

    expect(approval.proposal?.kind).toBe('notification.send@1');
    expect(approval.proposal?.recipient?.email).toBe('a@example.test');
    expect(approval.effect.failureCode).toBeNull();
  });

  it('reads a proposal whose recipient is no longer nameable', async () => {
    answers({
      ...APPROVAL,
      proposal: { ...APPROVAL.proposal, recipient: null },
    });

    const approval = await getAgentActionApproval(ORGANIZATION, 'exec_1');

    expect(approval.proposal?.recipient).toBeNull();
  });

  it.each([
    ['approve', approveAgentAction],
    ['reject', rejectAgentAction],
  ])('sends a %s decision with its note', async (verb, decide) => {
    answers(
      {
        ...APPROVAL,
        executionStatus: verb === 'approve' ? 'APPROVED' : 'REJECTED',
        approval: {
          ...APPROVAL.approval,
          status: verb === 'approve' ? 'APPROVED' : 'REJECTED',
          decidedAt: '2026-01-01T00:01:00.000Z',
          decidedByUserId: 'user_1',
          decisionNote: 'A note',
        },
      },
      201,
    );

    const decided = await decide(ORGANIZATION, 'exec_1', 'A note');

    const { url, init } = requested();

    expect(url).toBe(
      `${API_BASE_PATH}/organizations/${ORGANIZATION}/agent-action-approvals/exec_1/${verb}`,
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ note: 'A note' });
    expect(decided.approval.decisionNote).toBe('A note');
  });

  it('reads an effect that failed for a named reason', async () => {
    answers({
      ...APPROVAL,
      executionStatus: 'FAILED',
      effect: {
        attemptCount: 1,
        firstAttemptedAt: '2026-01-01T00:01:00.000Z',
        completedAt: '2026-01-01T00:01:01.000Z',
        failureCode: 'provider_rejected',
      },
    });

    const approval = await getAgentActionApproval(ORGANIZATION, 'exec_1');

    expect(approval.effect.failureCode).toBe('provider_rejected');
  });
});

describe('the runtime vocabularies', () => {
  it.each([
    [
      'approval statuses',
      AGENT_ACTION_APPROVAL_STATUSES,
      ['PENDING', 'APPROVED', 'REJECTED'],
    ],
    [
      'execution statuses',
      TOOL_EXECUTION_STATUSES,
      [
        'STARTED',
        'AWAITING_APPROVAL',
        'APPROVED',
        'REJECTED',
        'SUCCEEDED',
        'FAILED',
        'OUTCOME_UNKNOWN',
      ],
    ],
    [
      'failure codes',
      TOOL_FAILURE_CODES,
      [
        'precondition_organization',
        'precondition_authority',
        'precondition_approval',
        'precondition_recipient',
        'delivery_unsupported',
        'provider_rejected',
        'implementation_error',
        'output_rejected',
      ],
    ],
  ])('offers every %s the contract declares', (_what, offered, expected) => {
    expect([...offered]).toEqual(expected);
  });
});

describe('account administration', () => {
  /*
   * These three used to resolve to `void`, throwing away a documented result
   * that says which account was touched, whether it is now deleted, and how
   * many sessions the deactivation ended. The URL and method are unchanged;
   * what the caller can see is not.
   */
  it('deactivates a user and keeps what the API answered', async () => {
    answers(LIFECYCLE, 201);

    const result = await deactivateUserAccount('user_1');
    const { url, init } = requested();

    expect(url).toBe(`${API_BASE_PATH}/admin/users/user_1/deactivate`);
    expect(init.method).toBe('POST');
    expect(result).toEqual(LIFECYCLE);
    expect(result.revokedSessions).toBe(3);
  });

  it('sends no body when no reason is given', async () => {
    answers(LIFECYCLE, 201);

    await deactivateUserAccount('user_1');

    // Unchanged from before: an absent reason is an absent body.
    expect(requested().init.body).toBeUndefined();
  });

  it('sends the reason when one is given', async () => {
    answers(LIFECYCLE, 201);

    await deactivateUserAccount('user_1', 'Left the company');

    expect(JSON.parse(String(requested().init.body))).toEqual({
      reason: 'Left the company',
    });
  });

  it('restores a user and keeps the result', async () => {
    answers({ ...LIFECYCLE, deletedAt: null, revokedSessions: 0 }, 201);

    const result = await restoreUserAccount('user_1');
    const { url, init } = requested();

    expect(url).toBe(`${API_BASE_PATH}/admin/users/user_1/restore`);
    expect(init.method).toBe('POST');
    // A restored account is one that is no longer deleted.
    expect(result.deletedAt).toBeNull();
  });

  it('escapes an identifier rather than pasting it into the path', async () => {
    answers(LIFECYCLE, 201);

    await restoreUserAccount('user 1/../other');

    expect(requested().url).toBe(
      `${API_BASE_PATH}/admin/users/user%201%2F..%2Fother/restore`,
    );
  });

  it('deactivates own account and keeps the result', async () => {
    answers(LIFECYCLE, 201);

    const result = await deactivateSelfAccount();
    const { url, init } = requested();

    expect(url).toBe(`${API_BASE_PATH}/user/account/deactivate`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(result.userId).toBe('user_1');
  });

  it('carries a reason into an own-account deactivation', async () => {
    answers(LIFECYCLE, 201);

    await deactivateSelfAccount('No longer needed');

    expect(JSON.parse(String(requested().init.body))).toEqual({
      reason: 'No longer needed',
    });
  });
});

describe('a refused administration request', () => {
  /*
   * Generating these payloads changes nothing about authorization or about
   * how a refusal is read: the shared EH-01 decoder still owns
   * `error.details`, and a forbidden call is still forbidden with the same
   * status and code.
   */
  it('reads a forbidden call as forbidden, unchanged', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'FORBIDDEN', message: 'Not permitted' } },
        403,
      ),
    );

    const thrown = await listManagedSecrets().catch((error: unknown) => error);
    const error = thrown as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
  });

  it('reads a business refusal through the shared decoder', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'CONFLICT',
            message: 'Conflict',
            details: {
              kind: 'business',
              reason: 'That action has already been decided.',
            },
          },
        },
        409,
      ),
    );

    const thrown = await approveAgentAction(ORGANIZATION, 'exec_1').catch(
      (error: unknown) => error,
    );
    const error = thrown as ApiError;

    expect(error.status).toBe(409);
    expect(errorDetailLines(error.details)).toEqual([
      'That action has already been decided.',
    ]);
  });
});
