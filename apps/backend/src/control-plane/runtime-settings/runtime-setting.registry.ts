import { z } from 'zod';

import type { Prisma } from '../../generated/prisma/client';

/**
 * Operator-editable settings, declared in code with the schema that validates
 * them.
 *
 * The registry is the whole boundary. An arbitrary key/value table would let a
 * typo create a setting nothing reads, let a string reach a consumer expecting
 * a number, and let an operator set a batch size of two million because nothing
 * said otherwise. Here a key that is not declared cannot be written, and a
 * value that does not satisfy the declared schema cannot be written either — so
 * a consumer that asks for a setting gets something the schema already proved.
 *
 * What must NOT be added here is agent behaviour. Prompts, context policy and
 * output schemas belong to a versioned definition, because a durable run
 * accepted against version 1 has to still execute version 1 after someone edits
 * a row. A setting that changes what an agent *says* is a versioning bug wearing
 * a settings hat; a setting that changes how often a sweep runs is not.
 */

export type SettingSensitivity =
  /** Safe to display and to log. */
  | 'public'
  /**
   * Not a credential, but not for general display either — an internal URL, an
   * account identifier. Shown in the control plane, never in ordinary logs.
   */
  | 'internal';

/**
 * A setting has to survive a round trip through a `Json` column.
 *
 * Constrained to Prisma's own input type rather than left as `unknown`, so a
 * registry entry whose schema cannot be persisted is a compile error here
 * instead of a runtime surprise at the write. The case worth naming is a
 * schema that can yield `undefined` — any `.optional()` — because Prisma reads
 * `undefined` on an update as "leave this column alone", so `set()` would
 * answer 200 with a re-read state and change nothing at all. A transform
 * producing something unserialisable, such as a `Map`, is rejected here too.
 * (`Date` is allowed, and is Prisma's own behaviour: it serialises.)
 */
export type PersistableSettingValue = Prisma.InputJsonValue;

export type RuntimeSettingDefinition<
  T extends z.ZodType<PersistableSettingValue> =
    z.ZodType<PersistableSettingValue>,
> = {
  description: string;
  schema: T;
  /**
   * The value used when no row exists. Deliberately a value and not
   * `undefined`: a consumer should never have to handle "unset", because the
   * difference between unset and default is not one any caller can act on.
   */
  defaultValue: z.infer<T>;
  sensitivity: SettingSensitivity;
  /**
   * `false` for a setting that is readable through the control plane but only
   * changeable by deployment. Nothing uses it yet; it exists so that adding the
   * first such setting is a registry entry rather than a new mechanism.
   */
  editable: boolean;
};

/**
 * Bounds are mandatory in spirit even where the type does not force them.
 *
 * An unbounded integer setting is an outage an operator can cause by holding a
 * key down. Every numeric entry below states a range that the application is
 * known to behave sensibly across, and the range is enforced by the same schema
 * that parses the stored value, so a row written before a bound was tightened
 * fails on read rather than being used.
 */
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
      .max(10 * 1_024 * 1_024),
    defaultValue: 1_048_576,
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
