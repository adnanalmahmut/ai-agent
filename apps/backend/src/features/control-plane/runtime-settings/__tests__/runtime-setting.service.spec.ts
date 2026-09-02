import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { AppException } from '../../../../core/errors';
import type { PrismaService } from '../../../../infrastructure/database';
import { Prisma } from '../../../../generated/prisma/client';
import { ControlPlaneAuditService } from '../../audit/control-plane-audit.service';
import type { RuntimeSettingKey } from '../runtime-setting.registry';

/**
 * What the registry buys, and what it costs when a stored row stops satisfying
 * it.
 *
 * The behaviour under test is the one that only shows up in production: a row
 * written before a bound was tightened, or edited by hand, is *not* an outage.
 * It is logged and the code default is used. Getting that wrong in either
 * direction is expensive — throwing turns one bad row into every request
 * failing, and returning the row unparsed hands a consumer a value its type
 * says is impossible.
 *
 * The registry is synthetic because the shipped one has no non-editable entry
 * and no entry marked `internal`, so neither the editability guard nor the
 * "never log the value" rule could be observed against it.
 */

const SPEC_SETTINGS = {
  'spec.bounded_number': {
    description: 'Synthetic bounded integer.',
    schema: z.number().int().min(1).max(100),
    defaultValue: 10,
    sensitivity: 'public',
    editable: true,
  },
  'spec.locked': {
    description: 'Synthetic setting only a deployment may change.',
    schema: z.string().min(1),
    defaultValue: 'fixed-by-deployment',
    sensitivity: 'public',
    editable: false,
  },
  'spec.internal_url': {
    description: 'Synthetic internal endpoint, not for ordinary logs.',
    schema: z.url(),
    defaultValue: 'https://internal.example.test',
    sensitivity: 'internal',
    editable: true,
  },
} as const;

type SpecSettingKey = keyof typeof SPEC_SETTINGS;

const SPEC_SETTING_KEYS = Object.keys(SPEC_SETTINGS) as SpecSettingKey[];

jest.unstable_mockModule('../runtime-setting.registry', () => ({
  RUNTIME_SETTINGS: SPEC_SETTINGS,
  RUNTIME_SETTING_KEYS: SPEC_SETTING_KEYS,
  isRuntimeSettingKey: (value: string) => Object.hasOwn(SPEC_SETTINGS, value),
  runtimeSettingDefinition: (key: SpecSettingKey) => SPEC_SETTINGS[key],
}));

let RuntimeSettingService: typeof import('../runtime-setting.service').RuntimeSettingService;

beforeAll(async () => {
  ({ RuntimeSettingService } = await import('../runtime-setting.service'));
});

/** The synthetic keys are not members of the shipped union; say so once. */
const setting = (key: SpecSettingKey) => key as unknown as RuntimeSettingKey;

/**
 * A value that announces itself in any output that should not contain it. An
 * `internal` setting may hold an endpoint or an account identifier, so the rule
 * is that the log names the key and the reason and nothing else.
 */
const CANARY = 'CANARY-internal-value-do-not-log-0000';

type Row = { key: string; value: unknown; updatedAt: Date } | null;

const UPDATED_AT = new Date('2026-01-01T00:00:00.000Z');

const ACTOR_ID = 'user-operator-1';

describe('RuntimeSettingService', () => {
  const findUnique = jest.fn<(args: unknown) => Promise<Row>>();
  const findMany = jest.fn<(args: unknown) => Promise<NonNullable<Row>[]>>();
  const upsert = jest.fn<(args: unknown) => Promise<unknown>>();
  const deleteMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();

  /**
   * The audit write, captured rather than stubbed away, so what these tests
   * observe is the projection the real service builds.
   */
  const auditCreate = jest.fn<(args: unknown) => Promise<unknown>>();

  const prisma = {
    runtimeSetting: { findUnique, findMany, upsert, deleteMany },
    controlPlaneAuditEvent: { create: auditCreate },
    /** One client for both writes; that they commit together is an e2e claim. */
    $transaction: (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  } as unknown as PrismaService;

  const auditRow = () =>
    (auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> })?.data;

  const warn = jest.fn<(payload: unknown, message?: string) => void>();
  const logger = { warn } as unknown as PinoLogger;

  let service: InstanceType<typeof RuntimeSettingService>;

  /** Everything the logger was handed, as one searchable string. */
  const loggedText = () => JSON.stringify(warn.mock.calls);

  /** Everything the audit log was handed, as one searchable string. */
  const auditedText = () => JSON.stringify(auditCreate.mock.calls);

  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue(null);
    findMany.mockReset().mockResolvedValue([]);
    upsert.mockReset().mockResolvedValue({});
    deleteMany.mockReset().mockResolvedValue({ count: 1 });
    warn.mockReset();
    auditCreate.mockReset().mockResolvedValue({});

    service = new RuntimeSettingService(
      prisma,
      new ControlPlaneAuditService(prisma),
      logger,
    );
  });

  describe('get', () => {
    it('returns the code default when no row exists', async () => {
      await expect(service.get(setting('spec.bounded_number'))).resolves.toBe(
        10,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('returns the stored value when it satisfies the schema', async () => {
      findUnique.mockResolvedValue({
        key: 'spec.bounded_number',
        value: 42,
        updatedAt: UPDATED_AT,
      });

      await expect(service.get(setting('spec.bounded_number'))).resolves.toBe(
        42,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    /**
     * The row that predates a tightened bound. It must not be used and must not
     * throw: one bad row is a misconfiguration, and turning it into a failed
     * request for every caller would turn it into an outage.
     */
    it('falls back to the default when the stored value is out of bounds', async () => {
      findUnique.mockResolvedValue({
        key: 'spec.bounded_number',
        value: 5_000,
        updatedAt: UPDATED_AT,
      });

      await expect(service.get(setting('spec.bounded_number'))).resolves.toBe(
        10,
      );
    });

    it('falls back to the default when the stored value is the wrong type', async () => {
      findUnique.mockResolvedValue({
        key: 'spec.bounded_number',
        value: 'twelve',
        updatedAt: UPDATED_AT,
      });

      await expect(service.get(setting('spec.bounded_number'))).resolves.toBe(
        10,
      );
    });

    /**
     * The log has to be actionable and safe at once: an operator needs to know
     * *which* setting was rejected, and must not be shown the value, because an
     * `internal` setting is exactly the kind that carries something not meant
     * for ordinary logs.
     */
    it('logs the rejected key and reason without the rejected value', async () => {
      findUnique.mockResolvedValue({
        key: 'spec.internal_url',
        value: CANARY,
        updatedAt: UPDATED_AT,
      });

      const value = await service.get(setting('spec.internal_url'));

      expect(value).toBe(SPEC_SETTINGS['spec.internal_url'].defaultValue);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          settingKey: 'spec.internal_url',
          reason: 'stored_value_rejected',
        }),
        expect.any(String),
      );
      expect(loggedText()).toContain('spec.internal_url');
      expect(loggedText()).not.toContain(CANARY);
      expect(loggedText()).not.toContain('CANARY');
    });

    it('reads the row by primary key and selects only the value', async () => {
      await service.get(setting('spec.bounded_number'));

      expect(findUnique).toHaveBeenCalledWith({
        where: { key: 'spec.bounded_number' },
        select: { value: true },
      });
    });
  });

  describe('listAll', () => {
    it('reports a stored value as not being the default', async () => {
      findMany.mockResolvedValue([
        { key: 'spec.bounded_number', value: 42, updatedAt: UPDATED_AT },
      ]);

      const states = await service.listAll();

      expect(states.map((state) => state.key)).toEqual(SPEC_SETTING_KEYS);
      expect(states[0]).toEqual({
        key: 'spec.bounded_number',
        description: SPEC_SETTINGS['spec.bounded_number'].description,
        value: 42,
        isDefault: false,
        storedValueRejected: false,
        defaultValue: 10,
        sensitivity: 'public',
        editable: true,
        updatedAt: UPDATED_AT,
      });
    });

    it('shows the default, and never the rejected value, for an invalid row', async () => {
      findMany.mockResolvedValue([
        { key: 'spec.internal_url', value: CANARY, updatedAt: UPDATED_AT },
      ]);

      const states = await service.listAll();
      const state = states.find(
        (entry) => entry.key === ('spec.internal_url' as RuntimeSettingKey),
      );

      expect(state).toMatchObject({
        value: SPEC_SETTINGS['spec.internal_url'].defaultValue,
        isDefault: true,
        /**
         * The distinction the operator needs. `isDefault` is also true when
         * nothing was ever configured; this says a row exists and is being
         * ignored — otherwise the Platform shows the default beside the date
         * the operator set something else, with nothing to explain it, and
         * pressing reset appears to do nothing at all.
         */
        storedValueRejected: true,
      });
      expect(JSON.stringify(states)).not.toContain('CANARY');
    });

    it('does not flag a setting that was never configured as rejected', async () => {
      findMany.mockResolvedValue([]);

      const states = await service.listAll();

      expect(states.every((state) => state.isDefault)).toBe(true);
      expect(states.every((state) => !state.storedValueRejected)).toBe(true);
    });
  });

  describe('set', () => {
    it('stores a value the schema accepts', async () => {
      findMany.mockResolvedValue([
        { key: 'spec.bounded_number', value: 25, updatedAt: UPDATED_AT },
      ]);

      const state = await service.set({
        key: setting('spec.bounded_number'),
        value: 25,
        actorUserId: 'user-1',
      });

      expect(upsert).toHaveBeenCalledWith({
        where: { key: 'spec.bounded_number' },
        create: {
          key: 'spec.bounded_number',
          value: 25,
          updatedByUserId: 'user-1',
        },
        update: { value: 25, updatedByUserId: 'user-1' },
      });
      expect(state).toMatchObject({ value: 25, isDefault: false });
    });

    /**
     * A bounded setting is useless if the Platform cannot say why a value was
     * refused, so the issue messages are public. They describe the schema, not
     * the submission.
     */
    it.each([
      { label: 'above the maximum', value: 5_000 },
      { label: 'below the minimum', value: 0 },
      { label: 'not an integer', value: 2.5 },
      { label: 'not a number', value: 'twelve' },
    ])('refuses a value $label with issue messages', async ({ value }) => {
      const error = await service
        .set({
          key: setting('spec.bounded_number'),
          value,
          actorUserId: 'user-1',
        })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('VALIDATION_ERROR');

      const issues = (error as AppException).publicDetails?.issues as string[];
      expect(Array.isArray(issues)).toBe(true);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((issue) => typeof issue === 'string')).toBe(true);
      expect((error as AppException).context).toEqual({
        settingKey: 'spec.bounded_number',
      });
      expect(upsert).not.toHaveBeenCalled();
    });

    it('does not echo the submitted value in the refusal', async () => {
      const error = await service
        .set({
          key: setting('spec.internal_url'),
          value: CANARY,
          actorUserId: 'user-1',
        })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      expect(JSON.stringify(error)).not.toContain('CANARY');
      expect((error as AppException).message).not.toContain('CANARY');
    });

    /**
     * `editable: false` means "readable here, changed by deployment". It is
     * checked before the schema, so a caller learns the setting is not theirs
     * to change rather than being told their value was fine.
     */
    it('refuses a setting the registry does not mark editable', async () => {
      const error = await service
        .set({
          key: setting('spec.locked'),
          value: 'a perfectly valid string',
          actorUserId: 'user-1',
        })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('BAD_REQUEST');
      expect((error as AppException).context).toEqual({
        settingKey: 'spec.locked',
        reason: 'not_editable',
      });
      expect(upsert).not.toHaveBeenCalled();
    });
  });

  /**
   * Reset removes the row rather than writing the default into it.
   *
   * Writing the default would pin the setting to today's value: the row would
   * keep winning after the code default changed, which is the opposite of what
   * "reset" means.
   */
  describe('reset', () => {
    it('deletes the row instead of storing the default value', async () => {
      const state = await service.reset({
        key: setting('spec.bounded_number'),
        actorUserId: ACTOR_ID,
      });

      expect(deleteMany).toHaveBeenCalledWith({
        where: { key: 'spec.bounded_number' },
      });
      expect(upsert).not.toHaveBeenCalled();
      expect(state).toMatchObject({
        value: 10,
        isDefault: true,
        updatedAt: undefined,
      });
    });
  });

  /**
   * The audit log is the second place a setting's value can end up, and the
   * first one with a read surface every `controlPlane:read` holder can reach.
   * The registry's `sensitivity` has to govern it for the same reason it
   * governs the logger.
   */
  describe('audit', () => {
    it('records the previous and new value for a public setting', async () => {
      findUnique.mockResolvedValue({
        key: 'spec.bounded_number',
        value: 10,
        updatedAt: UPDATED_AT,
      });

      await service.set({
        key: setting('spec.bounded_number'),
        value: 42,
        actorUserId: ACTOR_ID,
      });

      expect(auditRow()).toMatchObject({
        action: 'runtimeSetting.set',
        resource: 'runtimeSetting',
        resourceKey: 'spec.bounded_number',
        actorUserId: ACTOR_ID,
        before: { kind: 'runtimeSettingValue', value: 10 },
        after: { kind: 'runtimeSettingValue', value: 42 },
      });
    });

    it('records that a setting had no stored value rather than inventing one', async () => {
      findUnique.mockResolvedValue(null);

      await service.set({
        key: setting('spec.bounded_number'),
        value: 42,
        actorUserId: ACTOR_ID,
      });

      // Prisma's SQL-NULL sentinel, not the JSON value `null`: the setting had
      // no stored state, which is a different fact from a stored `null`.
      expect(auditRow()?.before).toBe(Prisma.DbNull);
    });

    it('redacts the value of a setting the registry marks internal', async () => {
      findUnique.mockResolvedValue({
        key: 'spec.internal_url',
        value: `https://old.${CANARY}.example.test`,
        updatedAt: UPDATED_AT,
      });

      await service.set({
        key: setting('spec.internal_url'),
        value: `https://${CANARY}.example.test`,
        actorUserId: ACTOR_ID,
      });

      expect(auditedText()).not.toContain(CANARY);
      expect(auditRow()).toMatchObject({
        before: { kind: 'runtimeSettingValue', redacted: true },
        after: { kind: 'runtimeSettingValue', redacted: true },
      });
    });

    it('records the value a reset removed', async () => {
      findUnique.mockResolvedValue({
        key: 'spec.bounded_number',
        value: 42,
        updatedAt: UPDATED_AT,
      });

      await service.reset({
        key: setting('spec.bounded_number'),
        actorUserId: ACTOR_ID,
      });

      expect(auditRow()).toMatchObject({
        action: 'runtimeSetting.reset',
        before: { kind: 'runtimeSettingValue', value: 42 },
      });
      expect(auditRow()?.after).toBe(Prisma.DbNull);
    });

    /**
     * A refused mutation must leave no trace saying it happened. An audit log
     * that recorded attempts alongside changes would answer "was this ever set
     * to 5000" with a yes for a request the service rejected.
     */
    it('writes nothing when the value is refused', async () => {
      await expect(
        service.set({
          key: setting('spec.bounded_number'),
          value: 5_000,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(AppException);

      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('writes nothing when the setting is not editable', async () => {
      await expect(
        service.set({
          key: setting('spec.locked'),
          value: 'anything',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(AppException);

      expect(auditCreate).not.toHaveBeenCalled();
    });
  });
});
