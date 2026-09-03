import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../../core/errors';
import { PrismaService } from '../../../infrastructure/database';
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
  storedValueRejected: boolean;
  defaultValue: unknown;
  sensitivity: string;
  editable: boolean;
  updatedAt: Date | undefined;
};

@Injectable()
export class RuntimeSettingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ControlPlaneAuditService,
    private readonly logger: PinoLogger,
  ) {}

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

function settingState(
  definition: { sensitivity: string },
  value: unknown,
): ControlPlaneAuditState {
  return definition.sensitivity === 'public'
    ? { kind: 'runtimeSettingValue', value }
    : { kind: 'runtimeSettingValue', redacted: true };
}
