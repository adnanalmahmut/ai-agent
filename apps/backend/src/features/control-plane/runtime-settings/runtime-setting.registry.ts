import { z } from 'zod';

import type { Prisma } from '../../../generated/prisma/client';

export type SettingSensitivity = 'public' | 'internal';

export type PersistableSettingValue = Prisma.InputJsonValue;

export type RuntimeSettingDefinition<
  T extends z.ZodType<PersistableSettingValue> =
    z.ZodType<PersistableSettingValue>,
> = {
  description: string;
  schema: T;
  defaultValue: z.infer<T>;
  sensitivity: SettingSensitivity;
  editable: boolean;
};

export const RUNTIME_SETTINGS = {
  'agents.max_concurrent_runs_per_organization': {
    description:
      'How many agent runs one organization may have in flight before new requests are refused.',
    schema: z.number().int().min(1).max(1_000),
    defaultValue: 10,
    sensitivity: 'public',
    editable: true,
  },
  'knowledge.retrieval_max_chunks': {
    description:
      'Upper bound on chunks any single retrieval may return into a prompt.',
    schema: z.number().int().min(1).max(100),
    defaultValue: 12,
    sensitivity: 'public',
    editable: true,
  },
  'knowledge.ingestion_max_document_bytes': {
    description: 'Largest document accepted for ingestion, in bytes.',
    schema: z
      .number()
      .int()
      .min(1_024)
      .max(512 * 1_024),
    defaultValue: 256 * 1_024,
    sensitivity: 'public',
    editable: true,
  },
} as const satisfies Record<string, RuntimeSettingDefinition>;

export type RuntimeSettingKey = keyof typeof RUNTIME_SETTINGS;

export type RuntimeSettingValue<K extends RuntimeSettingKey> = z.infer<
  (typeof RUNTIME_SETTINGS)[K]['schema']
>;

export const RUNTIME_SETTING_KEYS = Object.keys(
  RUNTIME_SETTINGS,
) as RuntimeSettingKey[];

export function isRuntimeSettingKey(value: string): value is RuntimeSettingKey {
  return Object.hasOwn(RUNTIME_SETTINGS, value);
}

export function runtimeSettingDefinition<K extends RuntimeSettingKey>(
  key: K,
): (typeof RUNTIME_SETTINGS)[K] {
  return RUNTIME_SETTINGS[key];
}
