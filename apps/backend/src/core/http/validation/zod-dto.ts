import type { z } from 'zod';

export interface ZodDto<T extends z.ZodTypeAny = z.ZodTypeAny> {
  new (...args: any[]): z.infer<T>;
  zodSchema: T;
}

const ZOD_DTO_MARKER = Symbol('ZOD_DTO_MARKER');

export function createZodDto<T extends z.ZodTypeAny>(schema: T): ZodDto<T> {
  class AugmentableZodDto {
    public static readonly zodSchema = schema;
    public static readonly [ZOD_DTO_MARKER] = true;

    constructor(target: any) {
      if (target && typeof target === 'object') {
        Object.assign(this, target);
      }
    }
  }

  return AugmentableZodDto as unknown as ZodDto<T>;
}

export function isZodDto(target: unknown): target is ZodDto {
  return (
    typeof target === 'function' &&
    ZOD_DTO_MARKER in target &&
    (target as Record<typeof ZOD_DTO_MARKER, boolean>)[ZOD_DTO_MARKER] === true
  );
}
