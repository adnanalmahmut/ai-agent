import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../core/errors';
import { PrismaService } from '../../infrastructure/database';
import {
  ControlPlaneAuditService,
  type ControlPlaneAuditState,
} from '../audit/control-plane-audit.service';
import {
  RUNTIME_SETTING_KEYS,
  type RuntimeSettingKey,
  type RuntimeSettingValue,
  runtimeSettingDefinition,
} from './runtime-setting.registry';

export type RuntimeSettingState = {
  key: RuntimeSettingKey;
  description: string;
  value: unknown;
  isDefault: boolean;
  /**
   * True when a row exists but no longer satisfies its schema, so the default
   * is in force despite the operator having configured something.
   *
   * Distinct from `isDefault`, which is also true when nothing was ever set.
   * Collapsing the two hides the case that actually needs attention: a bound
   * tightened in code after a value was stored means the Platform would show
   * the default beside the date the operator set something else, with nothing
   * to say the two disagree — and pressing reset would appear to do nothing.
   */
  storedValueRejected: boolean;
  defaultValue: unknown;
  sensitivity: string;
  editable: boolean;
  updatedAt: Date | undefined;
};

/**
 * Typed operational settings, read through the registry that defines them.
 *
 * The registry is what makes this safe. A stored value is parsed with the
 * declared schema on every read, so the type a caller receives has been
 * proved rather than asserted, and a row that predates a tightened bound is
 * caught instead of used.
 *
 * Reads are uncached for the same reason feature flags are: an operator who
 * changes a limit expects the next request to respect it. These are consulted
 * far less often than flags — once per accepted operation, not once per
 * request — so the cost is smaller and the argument is stronger.
 */
@Injectable()
export class RuntimeSettingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ControlPlaneAuditService,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Reads one setting, falling back to its declared default.
   *
   * A stored value that fails its schema does not throw. It is logged and the
   * default is used, because the alternative is that one bad row takes down
   * every request that touches the setting — turning a misconfiguration into
   * an outage. The log names the key and the reason, never the value, since a
   * setting marked `internal` may carry something not meant for ordinary logs.
   */
  async get<K extends RuntimeSettingKey>(
    key: K,
  ): Promise<RuntimeSettingValue<K>> {
    const definition = runtimeSettingDefinition(key);
    const row = await this.prisma.runtimeSetting.findUnique({
      where: { key },
      select: { value: true },
    });

    if (row === null) return definition.defaultValue as RuntimeSettingValue<K>;

    const parsed = definition.schema.safeParse(row.value);

    if (!parsed.success) {
      this.logger.warn(
        { settingKey: key, reason: 'stored_value_rejected' },
        'Stored runtime setting failed validation; using the code default',
      );

      return definition.defaultValue as RuntimeSettingValue<K>;
    }

    return parsed.data as RuntimeSettingValue<K>;
  }

  async listAll(): Promise<RuntimeSettingState[]> {
    const rows = await this.prisma.runtimeSetting.findMany({
      select: { key: true, value: true, updatedAt: true },
    });
    const stored = new Map(rows.map((row) => [row.key, row]));

    return RUNTIME_SETTING_KEYS.map((key) => {
      const definition = runtimeSettingDefinition(key);
      const row = stored.get(key);
      const parsed =
        row === undefined ? undefined : definition.schema.safeParse(row.value);
      const storedValueRejected = row !== undefined && parsed?.success !== true;

      if (storedValueRejected) {
        this.logger.warn(
          { settingKey: key, reason: 'stored_value_rejected' },
          'Stored runtime setting failed validation; reporting the code default',
        );
      }

      return {
        key,
        description: definition.description,
        value: parsed?.success === true ? parsed.data : definition.defaultValue,
        isDefault: parsed?.success !== true,
        storedValueRejected,
        defaultValue: definition.defaultValue,
        sensitivity: definition.sensitivity,
        editable: definition.editable,
        updatedAt: row?.updatedAt,
      };
    });
  }

  async set(input: {
    key: RuntimeSettingKey;
    value: unknown;
    actorUserId: string;
  }): Promise<RuntimeSettingState> {
    const definition = runtimeSettingDefinition(input.key);

    if (!definition.editable) {
      throw new AppException('BAD_REQUEST', {
        context: { settingKey: input.key, reason: 'not_editable' },
      });
    }

    const parsed = definition.schema.safeParse(input.value);

    if (!parsed.success) {
      /**
       * The rejection reasons are returned to the operator, because a bounded
       * numeric setting is useless if the Platform cannot say *why* 5000 was
       * refused. They are Zod's own messages about the schema, never the
       * submitted value.
       */
      throw new AppException('VALIDATION_ERROR', {
        context: { settingKey: input.key },
        publicDetails: {
          issues: parsed.error.issues.map((issue) => issue.message),
        },
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.runtimeSetting.findUnique({
        where: { key: input.key },
        select: { value: true },
      });

      await tx.runtimeSetting.upsert({
        where: { key: input.key },
        create: {
          key: input.key,
          value: parsed.data,
          updatedByUserId: input.actorUserId,
        },
        update: {
          value: parsed.data,
          updatedByUserId: input.actorUserId,
        },
      });

      await this.audit.record(tx, {
        action: 'runtimeSetting.set',
        resourceKey: input.key,
        actorUserId: input.actorUserId,
        before: before === null ? null : settingState(definition, before.value),
        after: settingState(definition, parsed.data),
      });
    });

    const state = await this.listAll();

    return state.find((entry) => entry.key === input.key)!;
  }

  /** Restores the code default by removing the row, not by writing it. */
  async reset(input: {
    key: RuntimeSettingKey;
    actorUserId: string;
  }): Promise<RuntimeSettingState> {
    const definition = runtimeSettingDefinition(input.key);

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.runtimeSetting.findUnique({
        where: { key: input.key },
        select: { value: true },
      });

      await tx.runtimeSetting.deleteMany({ where: { key: input.key } });

      /**
       * A key with no stored row was already at its code default, so this reset
       * changed nothing and there is nothing to append. Recording it would put
       * a "reset runtime setting" event in the history of a setting nobody had
       * ever set — and the audit log is the artefact an incident review trusts.
       */
      if (before === null) return;

      await this.audit.record(tx, {
        action: 'runtimeSetting.reset',
        resourceKey: input.key,
        actorUserId: input.actorUserId,
        before: settingState(definition, before.value),
        after: null,
      });
    });

    const state = await this.listAll();

    return state.find((entry) => entry.key === input.key)!;
  }
}

/**
 * A setting's value as the audit log may record it.
 *
 * The registry's `sensitivity` decides, not the caller. Every setting is
 * `public` today and recording their values is the point of the log — an
 * operator asking "what was the limit before" wants the number. But `internal`
 * exists in the registry, and the day something is marked that way the audit
 * log must not be the surface that publishes it to everyone holding
 * `controlPlane:read`. Deciding here rather than at each call site means that
 * change is one word in the registry rather than an audit of every writer.
 */
function settingState(
  definition: { sensitivity: string },
  value: unknown,
): ControlPlaneAuditState {
  return definition.sensitivity === 'public'
    ? { kind: 'runtimeSettingValue', value }
    : { kind: 'runtimeSettingValue', redacted: true };
}
