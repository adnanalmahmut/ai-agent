import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import { ControlPlaneAuditService } from '../../../../../src/features/control-plane/audit/control-plane-audit.service';
import { AppException } from '../../../../../src/core/errors';
import type { PrismaService } from '../../../../../src/infrastructure/database';
import { Prisma } from '../../../../../src/generated/prisma/client';
import type {
  FeatureFlagDefinition,
  FeatureFlagKey,
} from '../../../../../src/features/control-plane/feature-flags/feature-flag.registry';
import type { FeatureFlagSource } from '../../../../../src/features/control-plane/feature-flags/feature-flag.service';

type SpecFlag = 'spec.default_on' | 'spec.default_off' | 'spec.platform_only';

const SPEC_FLAGS: Record<SpecFlag, FeatureFlagDefinition> = {
  'spec.default_on': {
    description: 'Synthetic flag that defaults to on.',
    defaultEnabled: true,
    organizationOverridable: true,
  },
  'spec.default_off': {
    description: 'Synthetic flag that defaults to off.',
    defaultEnabled: false,
    organizationOverridable: true,
  },
  'spec.platform_only': {
    description: 'Synthetic flag no organization may override.',
    defaultEnabled: false,
    organizationOverridable: false,
  },
};

const SPEC_FLAG_KEYS = Object.keys(SPEC_FLAGS) as SpecFlag[];

jest.unstable_mockModule(
  '../../../../../src/features/control-plane/feature-flags/feature-flag.registry',
  () => ({
    FEATURE_FLAGS: SPEC_FLAGS,
    FEATURE_FLAG_KEYS: SPEC_FLAG_KEYS,
    isFeatureFlagKey: (value: string) => Object.hasOwn(SPEC_FLAGS, value),
    featureFlagDefinition: (key: SpecFlag) => SPEC_FLAGS[key],
  }),
);

let FeatureFlagService: typeof import('../../../../../src/features/control-plane/feature-flags/feature-flag.service').FeatureFlagService;

beforeAll(async () => {
  ({ FeatureFlagService } =
    await import('../../../../../src/features/control-plane/feature-flags/feature-flag.service'));
});

const flag = (key: SpecFlag) => key as unknown as FeatureFlagKey;

const ORGANIZATION_ID = 'org-spec-1';
const ACTOR_ID = 'user-1';

type Override = { enabled: boolean } | null;

describe('FeatureFlagService', () => {
  const platformFindUnique = jest.fn<(args: unknown) => Promise<Override>>();
  const platformUpsert = jest.fn<(args: unknown) => Promise<unknown>>();
  const platformDeleteMany =
    jest.fn<(args: unknown) => Promise<{ count: number }>>();

  const organizationFindUnique =
    jest.fn<(args: unknown) => Promise<Override>>();
  const organizationUpsert = jest.fn<(args: unknown) => Promise<unknown>>();
  const organizationDeleteMany =
    jest.fn<(args: unknown) => Promise<{ count: number }>>();

  const organizationRecordFindUnique =
    jest.fn<(args: unknown) => Promise<{ id: string } | null>>();

  const auditCreate = jest.fn<(args: unknown) => Promise<unknown>>();

  const prisma = {
    featureFlagPlatformOverride: {
      findUnique: platformFindUnique,
      upsert: platformUpsert,
      deleteMany: platformDeleteMany,
    },
    featureFlagOrganizationOverride: {
      findUnique: organizationFindUnique,
      upsert: organizationUpsert,
      deleteMany: organizationDeleteMany,
    },
    organization: { findUnique: organizationRecordFindUnique },
    controlPlaneAuditEvent: { create: auditCreate },
    $transaction: (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  } as unknown as PrismaService;

  const auditRow = () =>
    (auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> })?.data;

  let service: InstanceType<typeof FeatureFlagService>;

  beforeEach(() => {
    platformFindUnique.mockReset().mockResolvedValue(null);
    platformUpsert.mockReset().mockResolvedValue({});
    platformDeleteMany.mockReset().mockResolvedValue({ count: 1 });
    organizationFindUnique.mockReset().mockResolvedValue(null);
    organizationUpsert.mockReset().mockResolvedValue({});
    organizationDeleteMany.mockReset().mockResolvedValue({ count: 1 });
    organizationRecordFindUnique
      .mockReset()
      .mockResolvedValue({ id: ORGANIZATION_ID });
    auditCreate.mockReset().mockResolvedValue({});

    service = new FeatureFlagService(
      prisma,
      new ControlPlaneAuditService(prisma),
    );
  });

  describe('precedence', () => {
    const cases: {
      key: SpecFlag;
      org: Override;
      platform: Override;
      enabled: boolean;
      source: FeatureFlagSource;
    }[] = [
      {
        key: 'spec.default_on',
        org: null,
        platform: null,
        enabled: true,
        source: 'default',
      },
      {
        key: 'spec.default_on',
        org: null,
        platform: { enabled: true },
        enabled: true,
        source: 'platform',
      },
      {
        key: 'spec.default_on',
        org: null,
        platform: { enabled: false },
        enabled: false,
        source: 'platform',
      },
      {
        key: 'spec.default_on',
        org: { enabled: true },
        platform: null,
        enabled: true,
        source: 'organization',
      },
      {
        key: 'spec.default_on',
        org: { enabled: true },
        platform: { enabled: true },
        enabled: true,
        source: 'organization',
      },
      {
        key: 'spec.default_on',
        org: { enabled: true },
        platform: { enabled: false },
        enabled: true,
        source: 'organization',
      },
      {
        key: 'spec.default_on',
        org: { enabled: false },
        platform: null,
        enabled: false,
        source: 'organization',
      },
      {
        key: 'spec.default_on',
        org: { enabled: false },
        platform: { enabled: true },
        enabled: false,
        source: 'organization',
      },
      {
        key: 'spec.default_on',
        org: { enabled: false },
        platform: { enabled: false },
        enabled: false,
        source: 'organization',
      },
      {
        key: 'spec.default_off',
        org: null,
        platform: null,
        enabled: false,
        source: 'default',
      },
      {
        key: 'spec.default_off',
        org: null,
        platform: { enabled: true },
        enabled: true,
        source: 'platform',
      },
      {
        key: 'spec.default_off',
        org: null,
        platform: { enabled: false },
        enabled: false,
        source: 'platform',
      },
      {
        key: 'spec.default_off',
        org: { enabled: true },
        platform: null,
        enabled: true,
        source: 'organization',
      },
      {
        key: 'spec.default_off',
        org: { enabled: true },
        platform: { enabled: true },
        enabled: true,
        source: 'organization',
      },
      {
        key: 'spec.default_off',
        org: { enabled: true },
        platform: { enabled: false },
        enabled: true,
        source: 'organization',
      },
      {
        key: 'spec.default_off',
        org: { enabled: false },
        platform: null,
        enabled: false,
        source: 'organization',
      },
      {
        key: 'spec.default_off',
        org: { enabled: false },
        platform: { enabled: true },
        enabled: false,
        source: 'organization',
      },
      {
        key: 'spec.default_off',
        org: { enabled: false },
        platform: { enabled: false },
        enabled: false,
        source: 'organization',
      },
    ];

    it.each(cases)(
      '$key with org=$org.enabled and platform=$platform.enabled resolves $enabled from $source',
      async ({ key, org, platform, enabled, source }) => {
        platformFindUnique.mockResolvedValue(platform);
        organizationFindUnique.mockResolvedValue(org);

        const state = await service.resolve(flag(key), {
          organizationId: ORGANIZATION_ID,
        });

        expect(state.enabled).toBe(enabled);
        expect(state.source).toBe(source);
        expect(
          await service.isEnabled(flag(key), {
            organizationId: ORGANIZATION_ID,
          }),
        ).toBe(enabled);
      },
    );

    it('reports both tiers and the default alongside the resolved value', async () => {
      platformFindUnique.mockResolvedValue({ enabled: false });
      organizationFindUnique.mockResolvedValue({ enabled: true });

      const state = await service.resolve(flag('spec.default_off'), {
        organizationId: ORGANIZATION_ID,
      });

      expect(state).toEqual({
        key: 'spec.default_off',
        description: SPEC_FLAGS['spec.default_off'].description,
        enabled: true,
        source: 'organization',
        defaultEnabled: false,
        platformOverride: false,
        organizationOverride: true,
        organizationOverridable: true,
      });
    });
  });

  describe('scope', () => {
    it('does not consult the organization tier when no organization is given', async () => {
      platformFindUnique.mockResolvedValue({ enabled: true });

      const state = await service.resolve(flag('spec.default_off'));

      expect(organizationFindUnique).not.toHaveBeenCalled();
      expect(state.source).toBe('platform');
      expect(state.organizationOverride).toBeUndefined();
    });

    it('looks an organization override up by the composite key', async () => {
      await service.resolve(flag('spec.default_off'), {
        organizationId: ORGANIZATION_ID,
      });

      expect(organizationFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId_key: {
              organizationId: ORGANIZATION_ID,
              key: 'spec.default_off',
            },
          },
        }),
      );
    });
  });

  describe('assertEnabled', () => {
    it('passes silently when the flag is on', async () => {
      platformFindUnique.mockResolvedValue({ enabled: true });

      await expect(
        service.assertEnabled(flag('spec.default_off')),
      ).resolves.toBeUndefined();
    });

    it('refuses with FEATURE_DISABLED when the flag is off', async () => {
      platformFindUnique.mockResolvedValue({ enabled: false });

      const error = await service
        .assertEnabled(flag('spec.default_on'), {
          organizationId: ORGANIZATION_ID,
        })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('FEATURE_DISABLED');
      expect((error as AppException).context).toEqual({
        featureFlag: 'spec.default_on',
        organizationId: ORGANIZATION_ID,
      });
      expect((error as AppException).publicDetails).toBeUndefined();
    });

    it('refuses when an organization override turns off a flag the platform enabled', async () => {
      platformFindUnique.mockResolvedValue({ enabled: true });
      organizationFindUnique.mockResolvedValue({ enabled: false });

      await expect(
        service.assertEnabled(flag('spec.default_on'), {
          organizationId: ORGANIZATION_ID,
        }),
      ).rejects.toBeInstanceOf(AppException);
    });
  });

  describe('listAll', () => {
    it('returns one state per registered flag', async () => {
      const states = await service.listAll();

      expect(states.map((state) => state.key)).toEqual(SPEC_FLAG_KEYS);
    });
  });

  describe('setPlatformOverride', () => {
    it('upserts the row and returns the platform-resolved state', async () => {
      platformFindUnique.mockResolvedValue({ enabled: true });

      const state = await service.setPlatformOverride({
        key: flag('spec.default_off'),
        enabled: true,
        actorUserId: 'user-1',
      });

      expect(platformUpsert).toHaveBeenCalledWith({
        where: { key: 'spec.default_off' },
        create: {
          key: 'spec.default_off',
          enabled: true,
          updatedByUserId: 'user-1',
        },
        update: { enabled: true, updatedByUserId: 'user-1' },
      });
      expect(state.enabled).toBe(true);
      expect(state.source).toBe('platform');
    });

    it('resolves the returned state without an organization scope', async () => {
      await service.setPlatformOverride({
        key: flag('spec.default_off'),
        enabled: true,
        actorUserId: 'user-1',
      });

      expect(organizationFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('clearing versus pinning to the default value', () => {
    it('pins the current default as a platform override that survives a default change', async () => {
      platformFindUnique.mockResolvedValue({ enabled: false });

      const state = await service.setPlatformOverride({
        key: flag('spec.default_off'),
        enabled: false,
        actorUserId: 'user-1',
      });

      expect(platformUpsert).toHaveBeenCalled();
      expect(platformDeleteMany).not.toHaveBeenCalled();
      expect(state).toMatchObject({
        enabled: false,
        source: 'platform',
        platformOverride: false,
      });
    });

    it('clears the override by deleting the row, leaving the code default in charge', async () => {
      platformFindUnique.mockResolvedValue(null);

      const state = await service.clearPlatformOverride({
        key: flag('spec.default_off'),
        actorUserId: ACTOR_ID,
      });

      expect(platformDeleteMany).toHaveBeenCalledWith({
        where: { key: 'spec.default_off' },
      });
      expect(platformUpsert).not.toHaveBeenCalled();
      expect(state).toMatchObject({
        enabled: false,
        source: 'default',
        platformOverride: undefined,
      });
    });

    it('clears an organization override by deleting only that organization row', async () => {
      const state = await service.clearOrganizationOverride({
        key: flag('spec.default_off'),
        organizationId: ORGANIZATION_ID,
        actorUserId: ACTOR_ID,
      });

      expect(organizationDeleteMany).toHaveBeenCalledWith({
        where: { organizationId: ORGANIZATION_ID, key: 'spec.default_off' },
      });
      expect(organizationUpsert).not.toHaveBeenCalled();
      expect(state.source).toBe('default');
    });
  });

  describe('setOrganizationOverride', () => {
    it('ignores a stored override once the registry stops scoping the flag', async () => {
      organizationFindUnique.mockResolvedValue({ enabled: true });
      platformFindUnique.mockResolvedValue(null);

      const state = await service.resolve(flag('spec.platform_only'), {
        organizationId: ORGANIZATION_ID,
      });

      expect(organizationFindUnique).not.toHaveBeenCalled();
      expect(state.enabled).toBe(false);
      expect(state.source).toBe('default');
      expect(state.organizationOverride).toBeUndefined();
    });

    it('refuses an organization that does not exist, and writes nothing', async () => {
      organizationRecordFindUnique.mockResolvedValue(null);

      const error = await service
        .setOrganizationOverride({
          key: flag('spec.default_off'),
          organizationId: 'no-such-organization',
          enabled: true,
          actorUserId: 'user-1',
        })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('NOT_FOUND');
      expect(organizationUpsert).not.toHaveBeenCalled();
    });

    it('refuses a flag the registry does not scope to organizations', async () => {
      const error = await service
        .setOrganizationOverride({
          key: flag('spec.platform_only'),
          organizationId: ORGANIZATION_ID,
          enabled: true,
          actorUserId: 'user-1',
        })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('BAD_REQUEST');
      expect((error as AppException).context).toEqual({
        featureFlag: 'spec.platform_only',
        reason: 'not_organization_scoped',
      });
      expect(organizationUpsert).not.toHaveBeenCalled();
    });

    it('writes an override for a flag the registry does scope to organizations', async () => {
      organizationFindUnique.mockResolvedValue({ enabled: true });

      const state = await service.setOrganizationOverride({
        key: flag('spec.default_off'),
        organizationId: ORGANIZATION_ID,
        enabled: true,
        actorUserId: 'user-1',
      });

      expect(organizationUpsert).toHaveBeenCalledWith({
        where: {
          organizationId_key: {
            organizationId: ORGANIZATION_ID,
            key: 'spec.default_off',
          },
        },
        create: {
          key: 'spec.default_off',
          organizationId: ORGANIZATION_ID,
          enabled: true,
          updatedByUserId: 'user-1',
        },
        update: { enabled: true, updatedByUserId: 'user-1' },
      });
      expect(state).toMatchObject({ enabled: true, source: 'organization' });
    });
  });

  describe('audit', () => {
    it('records what a platform override was before it changed', async () => {
      platformFindUnique.mockResolvedValue({ enabled: false });

      await service.setPlatformOverride({
        key: flag('spec.default_off'),
        enabled: true,
        actorUserId: ACTOR_ID,
      });

      expect(auditRow()).toMatchObject({
        action: 'featureFlag.setPlatformOverride',
        resource: 'featureFlag',
        resourceKey: 'spec.default_off',
        actorUserId: ACTOR_ID,
        before: { kind: 'featureFlagOverride', enabled: false },
        after: { kind: 'featureFlagOverride', enabled: true },
      });
    });

    it('distinguishes a first override from a change to one', async () => {
      platformFindUnique.mockResolvedValue(null);

      await service.setPlatformOverride({
        key: flag('spec.default_off'),
        enabled: true,
        actorUserId: ACTOR_ID,
      });

      expect(auditRow()?.before).toBe(Prisma.DbNull);
    });

    it('records the value a cleared platform override had', async () => {
      platformFindUnique.mockResolvedValue({ enabled: true });

      await service.clearPlatformOverride({
        key: flag('spec.default_off'),
        actorUserId: ACTOR_ID,
      });

      expect(auditRow()).toMatchObject({
        action: 'featureFlag.clearPlatformOverride',
        before: { kind: 'featureFlagOverride', enabled: true },
      });
      expect(auditRow()?.after).toBe(Prisma.DbNull);
    });

    it('records the organization an override applied to', async () => {
      organizationFindUnique.mockResolvedValue(null);

      await service.setOrganizationOverride({
        key: flag('spec.default_off'),
        organizationId: ORGANIZATION_ID,
        enabled: true,
        actorUserId: ACTOR_ID,
      });

      expect(auditRow()).toMatchObject({
        action: 'featureFlag.setOrganizationOverride',
        organizationId: ORGANIZATION_ID,
        after: { kind: 'featureFlagOverride', enabled: true },
      });
    });

    it('records a cleared organization override against its organization', async () => {
      organizationFindUnique.mockResolvedValue({ enabled: true });

      await service.clearOrganizationOverride({
        key: flag('spec.default_off'),
        organizationId: ORGANIZATION_ID,
        actorUserId: ACTOR_ID,
      });

      expect(auditRow()).toMatchObject({
        action: 'featureFlag.clearOrganizationOverride',
        organizationId: ORGANIZATION_ID,
        before: { kind: 'featureFlagOverride', enabled: true },
      });
    });

    it('writes nothing when an organization override is refused as out of scope', async () => {
      await expect(
        service.setOrganizationOverride({
          key: flag('spec.platform_only'),
          organizationId: ORGANIZATION_ID,
          enabled: true,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(AppException);

      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('writes nothing when the organization does not exist', async () => {
      organizationRecordFindUnique.mockResolvedValue(null);

      await expect(
        service.setOrganizationOverride({
          key: flag('spec.default_off'),
          organizationId: 'org-missing',
          enabled: true,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(AppException);

      expect(auditCreate).not.toHaveBeenCalled();
    });
  });
});
