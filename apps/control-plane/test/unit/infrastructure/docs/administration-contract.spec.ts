import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';

import {
  AccountLifecycleController,
  SelfAccountLifecycleController,
} from '../../../../src/infrastructure/auth/lifecycle.controller';
import { AgentActionApprovalController } from '../../../../src/features/agent-management/approvals/agent-action-approval.controller';
import { AppModule } from '../../../../src/api/app.module';
import { ControlPlaneController } from '../../../../src/features/control-plane/control-plane.controller';
import { DEFAULT_APPLICATION_NAME } from '../../../../src/infrastructure/config';
import { createApplicationOpenApiDocument } from '../../../../src/infrastructure/docs';

/**
 * The documented approvals and platform-administration payloads.
 *
 * These operations answered with no documented body, so Platform described
 * every one of them for itself. Asserting the document is what keeps the
 * generated types the only description, and — for managed secrets — what
 * keeps a credential from ever appearing in one.
 *
 * Preview mode builds the module graph and its route metadata without
 * instantiating a provider, so this needs no database, no Redis, no
 * credentials and no listener.
 */

type JsonSchema = {
  type?: string;
  format?: string;
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
};

type Operation = {
  operationId?: string;
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    schema?: JsonSchema;
  }[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses: Record<
    string,
    { content?: Record<string, { schema?: JsonSchema }> } | undefined
  >;
};

const CONTROL_PLANE = '/platform/control-plane';
const ADMIN_USERS = '/admin/users/{userId}';
const SELF_ACCOUNT = '/user/account/deactivate';
const APPROVALS = '/organizations/{organizationId}/agent-action-approvals';

let app: INestApplication;
let paths: Record<string, Record<string, Operation>>;

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`the document does not describe ${what}`);
  }

  return value;
}

const operation = (path: string, method: string): Operation =>
  must(must(paths[path], path)[method], `${method.toUpperCase()} ${path}`);

function successData(path: string, method: string, status: string): JsonSchema {
  const envelope = must(
    operation(path, method).responses[status]?.content?.['application/json']
      ?.schema,
    `a ${status} body for ${method.toUpperCase()} ${path}`,
  );

  expect(envelope.required).toEqual(['success', 'data', 'meta']);

  return must(envelope.properties?.data, `response data for ${path}`);
}

const requestSchema = (path: string, method: string): JsonSchema =>
  must(
    operation(path, method).requestBody?.content?.['application/json']?.schema,
    `a request body for ${method.toUpperCase()} ${path}`,
  );

const keys = (schema: JsonSchema, what: string) =>
  Object.keys(must(schema.properties, what));

/** Every property name anywhere inside a schema, however deeply nested. */
function everyPropertyName(schema: JsonSchema): string[] {
  const found: string[] = [];
  const walk = (node: JsonSchema | undefined) => {
    if (node === undefined) return;

    for (const [name, child] of Object.entries(node.properties ?? {})) {
      found.push(name);
      walk(child);
    }

    walk(node.items);
    for (const branch of node.anyOf ?? []) walk(branch);
  };

  walk(schema);
  return found;
}

beforeAll(async () => {
  app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    bodyParser: false,
  });
  app.setGlobalPrefix('api');

  paths = createApplicationOpenApiDocument(app, DEFAULT_APPLICATION_NAME)
    .paths as unknown as Record<string, Record<string, Operation>>;
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('approvals contract', () => {
  it.each([
    [APPROVALS, 'get', 'listAgentActionApprovals'],
    [`${APPROVALS}/{toolExecutionId}`, 'get', 'getAgentActionApproval'],
    [`${APPROVALS}/{toolExecutionId}/approve`, 'post', 'approveAgentAction'],
    [`${APPROVALS}/{toolExecutionId}/reject`, 'post', 'rejectAgentAction'],
  ])('names %s %s as %s', (path, method, operationId) => {
    expect(operation(path, method).operationId).toBe(operationId);
  });

  const approval = () =>
    successData(`${APPROVALS}/{toolExecutionId}`, 'get', '200');

  it('describes the action, its decision and what became of it', () => {
    expect(keys(approval(), 'an approval')).toEqual([
      'toolExecutionId',
      'organizationId',
      'agentRunId',
      'agentId',
      'agentVersion',
      'toolId',
      'toolVersion',
      'executionStatus',
      'approval',
      'proposal',
      'effect',
    ]);
  });

  it('constrains the decision to the three states an approver can reach', () => {
    const decision = must(approval().properties?.approval, 'a decision');

    expect(decision.properties?.status?.enum).toEqual([
      'PENDING',
      'APPROVED',
      'REJECTED',
    ]);
    expect(keys(decision, 'a decision')).toEqual([
      'status',
      'requestedAt',
      'decidedAt',
      'decidedByUserId',
      'decisionNote',
    ]);
  });

  it('keeps the execution lifecycle separate from the decision', () => {
    expect(approval().properties?.executionStatus?.enum).toEqual([
      'STARTED',
      'SUCCEEDED',
      'FAILED',
      'AWAITING_APPROVAL',
      'APPROVED',
      'REJECTED',
      'OUTCOME_UNKNOWN',
    ]);
  });

  it('describes the proposal as one known kind, or nothing', () => {
    const [proposal] = must(approval().properties?.proposal?.anyOf, 'proposal');

    // A single-member vocabulary is a `const`, not a one-value `enum`.
    expect(proposal.properties?.kind?.const).toBe('notification.send@1');
    expect(keys(proposal, 'a proposal')).toEqual([
      'kind',
      'recipient',
      'subject',
      'body',
    ]);
  });

  it('names every failure an effect can end with', () => {
    const effect = must(approval().properties?.effect, 'an effect');
    const [code] = must(effect.properties?.failureCode?.anyOf, 'a failure');

    expect(code.enum).toEqual([
      'implementation_error',
      'output_rejected',
      'precondition_organization',
      'precondition_authority',
      'precondition_approval',
      'precondition_recipient',
      'delivery_unsupported',
      'provider_rejected',
    ]);
  });

  it('documents the page and its filter', () => {
    const page = successData(APPROVALS, 'get', '200');
    const parameters = operation(APPROVALS, 'get').parameters ?? [];
    const status = must(
      parameters.find((p) => p.in === 'query' && p.name === 'status'),
      'a status filter',
    );

    expect(keys(page, 'a page')).toEqual(['items', 'nextCursor']);
    expect(page.properties?.nextCursor?.anyOf).toEqual([
      { type: 'string' },
      { type: 'null' },
    ]);
    expect(status.required ?? false).toBe(false);
    expect(status.schema?.enum).toEqual(['PENDING', 'APPROVED', 'REJECTED']);
  });

  it.each(['approve', 'reject'])(
    'answers a %s decision with the approval it decided',
    (verb) => {
      const path = `${APPROVALS}/{toolExecutionId}/${verb}`;

      expect(requestSchema(path, 'post').properties?.note).toMatchObject({
        type: 'string',
      });
      // A decision is a POST with no `@HttpCode`, so Nest answers 201.
      expect(successData(path, 'post', '201')).toEqual(approval());
    },
  );
});

describe('platform administration contract', () => {
  it.each([
    [`${CONTROL_PLANE}/feature-flags`, 'get', 'listFeatureFlags'],
    [
      `${CONTROL_PLANE}/feature-flags/{key}`,
      'put',
      'setFeatureFlagPlatformOverride',
    ],
    [
      `${CONTROL_PLANE}/feature-flags/{key}`,
      'delete',
      'clearFeatureFlagPlatformOverride',
    ],
    [`${CONTROL_PLANE}/settings`, 'get', 'listRuntimeSettings'],
    [`${CONTROL_PLANE}/settings/{key}`, 'put', 'setRuntimeSetting'],
    [`${CONTROL_PLANE}/settings/{key}`, 'delete', 'resetRuntimeSetting'],
    [`${CONTROL_PLANE}/secrets`, 'get', 'listManagedSecrets'],
    [`${CONTROL_PLANE}/secrets/{key}`, 'put', 'setManagedSecret'],
    [`${CONTROL_PLANE}/secrets/{key}`, 'delete', 'removeManagedSecret'],
    [`${CONTROL_PLANE}/audit`, 'get', 'listControlPlaneAudit'],
  ])('names %s %s as %s', (path, method, operationId) => {
    expect(operation(path, method).operationId).toBe(operationId);
  });

  describe('feature flags', () => {
    it('describes where a flag value came from and what may override it', () => {
      const flag = must(
        successData(`${CONTROL_PLANE}/feature-flags`, 'get', '200').items,
        'a flag',
      );

      expect(keys(flag, 'a flag')).toEqual([
        'key',
        'description',
        'enabled',
        'source',
        'defaultEnabled',
        'platformOverride',
        'organizationOverride',
        'organizationOverridable',
      ]);
      expect(flag.properties?.source?.enum).toEqual([
        'organization',
        'platform',
        'default',
      ]);
      // An override that was never set is absent, not null.
      expect(flag.required).toEqual([
        'key',
        'description',
        'enabled',
        'source',
        'defaultEnabled',
        'organizationOverridable',
      ]);
    });

    it('answers a set and a clear with the flag they changed', () => {
      const listed = must(
        successData(`${CONTROL_PLANE}/feature-flags`, 'get', '200').items,
        'a flag',
      );

      expect(
        successData(`${CONTROL_PLANE}/feature-flags/{key}`, 'put', '200'),
      ).toEqual(listed);
      expect(
        successData(`${CONTROL_PLANE}/feature-flags/{key}`, 'delete', '200'),
      ).toEqual(listed);
    });

    it('takes only the enabled bit as a body', () => {
      const body = requestSchema(`${CONTROL_PLANE}/feature-flags/{key}`, 'put');

      expect(keys(body, 'an override')).toEqual(['enabled']);
      expect(body.required).toEqual(['enabled']);
    });
  });

  describe('runtime settings', () => {
    it('describes the envelope around a value it does not constrain', () => {
      const setting = must(
        successData(`${CONTROL_PLANE}/settings`, 'get', '200').items,
        'a setting',
      );

      expect(keys(setting, 'a setting')).toEqual([
        'key',
        'description',
        'value',
        'isDefault',
        'storedValueRejected',
        'defaultValue',
        'sensitivity',
        'editable',
        'updatedAt',
      ]);
      expect(setting.properties?.sensitivity?.enum).toEqual([
        'public',
        'internal',
      ]);
    });
  });

  describe('managed secrets stay write-only', () => {
    const responses = () => [
      must(
        successData(`${CONTROL_PLANE}/secrets`, 'get', '200').items,
        'a secret slot',
      ),
      successData(`${CONTROL_PLANE}/secrets/{key}`, 'put', '200'),
      successData(`${CONTROL_PLANE}/secrets/{key}`, 'delete', '200'),
    ];

    it('accepts a credential', () => {
      const body = requestSchema(`${CONTROL_PLANE}/secrets/{key}`, 'put');

      expect(keys(body, 'a credential')).toEqual(['value', 'label']);
      expect(body.required).toEqual(['value']);
    });

    it('answers with metadata only, on every secret operation', () => {
      for (const response of responses()) {
        expect(keys(response, 'a secret slot')).toEqual([
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
      }
    });

    /*
     * The list above is exact, so a new field fails that test. This one says
     * why it would matter: no response may carry the credential, the material
     * that protects it, or anything derived from either — at any depth.
     */
    it.each([
      'value',
      'secret',
      'plaintext',
      'ciphertext',
      'encrypted',
      'encryptionKey',
      'dataKey',
      'credential',
      'apiKey',
      'token',
    ])('never carries a field named %s, at any depth', (forbidden) => {
      for (const response of responses()) {
        expect(everyPropertyName(response)).not.toContain(forbidden);
      }
    });

    it('says whether a slot is filled and whether it can still be read', () => {
      const [listed] = responses();

      expect(listed.properties?.configured).toMatchObject({
        type: 'boolean',
      });
      expect(listed.properties?.usable).toMatchObject({ type: 'boolean' });
      expect(listed.required).toEqual([
        'key',
        'description',
        'configured',
        'usable',
      ]);
    });
  });

  describe('audit', () => {
    it('documents a cursor page of change history', () => {
      const page = successData(`${CONTROL_PLANE}/audit`, 'get', '200');

      expect(keys(page, 'a page')).toEqual(['items', 'nextCursor']);
      expect(
        keys(must(page.properties?.items?.items, 'an entry'), 'an entry'),
      ).toEqual([
        'id',
        'occurredAt',
        'actorUserId',
        'resource',
        'action',
        'resourceKey',
        'organizationId',
        'before',
        'after',
      ]);
    });

    it('leaves the action a string, because history is not a vocabulary', () => {
      const entry = must(
        successData(`${CONTROL_PLANE}/audit`, 'get', '200').properties?.items
          ?.items,
        'an entry',
      );

      // An event written by an earlier release carries whatever that release
      // called it, and the screen already falls back to an unknown label.
      expect(entry.properties?.action).toMatchObject({ type: 'string' });
      expect(entry.properties?.action?.enum).toBeUndefined();
    });

    it('offers the three families as a filter', () => {
      const resource = must(
        (operation(`${CONTROL_PLANE}/audit`, 'get').parameters ?? []).find(
          (parameter) =>
            parameter.in === 'query' && parameter.name === 'resource',
        ),
        'a resource filter',
      );

      expect(resource.required ?? false).toBe(false);
      expect(resource.schema?.enum).toEqual([
        'featureFlag',
        'runtimeSetting',
        'managedSecret',
      ]);
    });
  });
});

describe('account administration contract', () => {
  it.each([
    [`${ADMIN_USERS}/deactivate`, 'post', 'deactivateUserAccount'],
    [`${ADMIN_USERS}/restore`, 'post', 'restoreUserAccount'],
    [SELF_ACCOUNT, 'post', 'deactivateSelfAccount'],
  ])('names %s %s as %s', (path, method, operationId) => {
    expect(operation(path, method).operationId).toBe(operationId);
  });

  it.each([`${ADMIN_USERS}/deactivate`, `${ADMIN_USERS}/restore`])(
    'takes the account from the path on %s',
    (path) => {
      const parameter = must(
        (operation(path, 'post').parameters ?? []).find(
          (candidate) => candidate.in === 'path' && candidate.name === 'userId',
        ),
        `a userId path parameter on ${path}`,
      );

      expect(parameter.required).toBe(true);
    },
  );

  it('deactivating own account needs no path parameter', () => {
    expect(
      (operation(SELF_ACCOUNT, 'post').parameters ?? []).filter(
        (parameter) => parameter.in === 'path',
      ),
    ).toEqual([]);
  });

  /*
   * The reason is optional, but it is a described field. Documenting the body
   * as a bare object generated `Record<string, never>`, which told a client
   * the endpoint accepts nothing.
   */
  it.each([`${ADMIN_USERS}/deactivate`, SELF_ACCOUNT])(
    'describes the optional reason on %s',
    (path) => {
      const body = requestSchema(path, 'post');

      expect(keys(body, 'a reason')).toEqual(['reason']);
      expect(body.properties?.reason).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 500,
      });
      // Nothing is required, so a caller may send no body at all.
      expect(body.required ?? []).toEqual([]);
    },
  );

  it('invents no body for a restore, which accepts none', () => {
    expect(
      operation(`${ADMIN_USERS}/restore`, 'post').requestBody,
    ).toBeUndefined();
  });

  it.each([
    `${ADMIN_USERS}/deactivate`,
    `${ADMIN_USERS}/restore`,
    SELF_ACCOUNT,
  ])('answers %s with what it did, at 201', (path) => {
    // A POST with no `@HttpCode`, so Nest answers 201.
    const data = successData(path, 'post', '201');

    expect(keys(data, 'a lifecycle result')).toEqual([
      'userId',
      'deletedAt',
      'revokedSessions',
    ]);
    expect(data.properties?.deletedAt?.anyOf).toEqual([
      expect.objectContaining({ type: 'string', format: 'date-time' }),
      { type: 'null' },
    ]);
    expect(data.properties?.revokedSessions).toMatchObject({
      type: 'integer',
    });
  });
});

/**
 * Documenting a payload must not move who may ask for it. These read the
 * metadata the guards consume, so a decorator dropped while adding a response
 * schema fails here rather than in production.
 */
describe('authorization is unchanged', () => {
  const permissionOf = (
    controller: object,
    handler: string,
    metadataKey: string,
  ): unknown =>
    Reflect.getMetadata(
      metadataKey,
      (controller as { prototype: Record<string, () => unknown> }).prototype[
        handler
      ],
    );

  it.each([
    ['list', { agentActionApproval: ['read'] }],
    ['detail', { agentActionApproval: ['read'] }],
    ['approve', { agentActionApproval: ['decide'] }],
    ['reject', { agentActionApproval: ['decide'] }],
  ])(
    'still requires organization permission on approvals.%s',
    (handler, expected) => {
      expect(
        permissionOf(
          AgentActionApprovalController,
          handler,
          'organizationPermission',
        ),
      ).toEqual(expected);
    },
  );

  it.each([
    ['listFeatureFlags', { controlPlane: ['read'] }],
    ['listFeatureFlagsForOrganization', { controlPlane: ['read'] }],
    ['setFeatureFlag', { controlPlane: ['write'] }],
    ['clearFeatureFlag', { controlPlane: ['write'] }],
    ['setOrganizationFeatureFlag', { controlPlane: ['write'] }],
    ['clearOrganizationFeatureFlag', { controlPlane: ['write'] }],
    ['listSettings', { controlPlane: ['read'] }],
    ['setSetting', { controlPlane: ['write'] }],
    ['resetSetting', { controlPlane: ['write'] }],
    ['listSecrets', { controlPlane: ['read'] }],
    ['setSecret', { managedSecret: ['write'] }],
    ['removeSecret', { managedSecret: ['write'] }],
    ['listAudit', { controlPlane: ['read'] }],
  ])(
    'still requires a platform permission on controlPlane.%s',
    (handler, expected) => {
      expect(
        permissionOf(ControlPlaneController, handler, 'USER_HAS_PERMISSION'),
      ).toEqual({ permissions: expected });
    },
  );

  it.each([
    ['deactivate', { accountLifecycle: ['deactivate'] }],
    ['restore', { accountLifecycle: ['restore'] }],
  ])(
    'still requires a platform permission on accounts.%s',
    (handler, expected) => {
      expect(
        permissionOf(
          AccountLifecycleController,
          handler,
          'USER_HAS_PERMISSION',
        ),
      ).toEqual({ permissions: expected });
    },
  );

  it('still lets any signed-in user deactivate their own account', () => {
    // Deliberately unguarded: the session is the authorization, and a
    // permission here would lock a user out of their own account. It is also
    // not public — documenting the body must not have made it either.
    expect(
      permissionOf(
        SelfAccountLifecycleController,
        'deactivateSelf',
        'USER_HAS_PERMISSION',
      ),
    ).toBeUndefined();
    expect(
      permissionOf(SelfAccountLifecycleController, 'deactivateSelf', 'PUBLIC'),
    ).toBeUndefined();
  });
});
