import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import { AppException } from '../../../core/errors';
import type { PrismaService } from '../../../database';
import type {
  FeatureFlagDefinition,
  FeatureFlagKey,
} from '../feature-flag.registry';
import type { FeatureFlagSource } from '../feature-flag.service';

/**
 * The precedence rule, stated once in the service and checked exhaustively
 * here.
 *
 * ## Why the registry is replaced
 *
 * Every flag the application actually ships defaults to `false` and is
 * organization-overridable, so the real registry cannot express two of the
 * behaviours this service is responsible for: resolving to a default of
 * `true`, and refusing an organization override on a flag that is not scoped
 * that way. A spec bound to the shipped registry would pass with
 * `enabled: false` hardcoded into the default branch and with the scope guard
 * deleted. A synthetic registry makes both observable.
 *
 * What is deliberately not asserted here is the content of the real registry —
 * which flags exist and what they default to is a product decision, and pinning
 * it in this file would make every future flag a test edit.
 */

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

jest.unstable_mockModule('../feature-flag.registry', () => ({
  FEATURE_FLAGS: SPEC_FLAGS,
  FEATURE_FLAG_KEYS: SPEC_FLAG_KEYS,
  isFeatureFlagKey: (value: string) => Object.hasOwn(SPEC_FLAGS, value),
  featureFlagDefinition: (key: SpecFlag) => SPEC_FLAGS[key],
}));

let FeatureFlagService: typeof import('../feature-flag.service').FeatureFlagService;

beforeAll(async () => {
  ({ FeatureFlagService } = await import('../feature-flag.service'));
});

/** The synthetic keys are not members of the shipped union; say so once. */
const flag = (key: SpecFlag) => key as unknown as FeatureFlagKey;

const ORGANIZATION_ID = 'org-spec-1';

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

  /** Present so an organization-addressed call can be refused when it is absent. */
  const organizationRecordFindUnique =
    jest.fn<(args: unknown) => Promise<{ id: string } | null>>();

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
  } as unknown as PrismaService;

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

    service = new FeatureFlagService(prisma);
  });

  /**
   * Every combination of the three tiers, written out rather than computed.
   *
   * A table whose expectation was derived with `org ?? platform ?? default`
   * would restate the implementation and agree with it however it changed.
   * These 18 rows are the rule as a human would describe it, and the four that
   * matter most — an organization override that disagrees with the platform in
   * either direction — are the ones an inverted precedence gets wrong.
   */
  describe('precedence', () => {
    const cases: {
      key: SpecFlag;
      org: Override;
      platform: Override;
      enabled: boolean;
      source: FeatureFlagSource;
    }[] = [
      // Default true.
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
      // Default false.
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

  /**
   * A platform-scoped caller is not the same as an organization with no
   * override. The distinction is invisible in the resolved value today and
   * stops being invisible the moment an organization override exists, so the
   * assertion is that the tier is not consulted at all.
   */
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
      // The key is internal context, never a public detail.
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

    /**
     * A platform write must not resolve through an organization, or the value
     * an operator is shown after a platform change would be one tenant's view
     * of it.
     */
    it('resolves the returned state without an organization scope', async () => {
      await service.setPlatformOverride({
        key: flag('spec.default_off'),
        enabled: true,
        actorUserId: 'user-1',
      });

      expect(organizationFindUnique).not.toHaveBeenCalled();
    });
  });

  /**
   * Clearing and pinning look identical while the code default agrees with the
   * pinned value, and stop being identical the moment the default changes. The
   * service has to offer both, and the observable difference is `source`.
   */
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

      const state = await service.clearPlatformOverride(
        flag('spec.default_off'),
      );

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
      });

      expect(organizationDeleteMany).toHaveBeenCalledWith({
        where: { organizationId: ORGANIZATION_ID, key: 'spec.default_off' },
      });
      expect(organizationUpsert).not.toHaveBeenCalled();
      expect(state.source).toBe('default');
    });
  });

  /**
   * The scope guard, refused on write.
   *
   * Ignoring the row on read instead would show one value in the Platform and
   * behave as another — the worst outcome for a mechanism whose only job is to
   * be believed. So the assertion is not merely that it throws, but that
   * nothing was written.
   */
  describe('setOrganizationOverride', () => {
    /**
     * A flag can be narrowed in code after organization overrides were already
     * stored — `setOrganizationOverride` refuses new ones, but it cannot
     * un-write the rows that were legal when they were made. Evaluation has to
     * agree with the registry as it stands now, or the registry's declaration
     * is simply false for any organization that got in first.
     */
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

    /**
     * An organization-addressed route cannot check its organization against a
     * registry the way it checks a flag key, so the service checks the table.
     * Without it the write reaches PostgreSQL and returns a foreign-key
     * violation — which nothing maps, so it surfaces as a 500 with a stack
     * trace, for what is an ordinary "no such organization".
     */
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
});
