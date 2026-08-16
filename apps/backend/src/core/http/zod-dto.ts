import type { z } from 'zod';

/**
 * A DTO class that carries its Zod schema.
 *
 * Nest needs a *class* as the parameter type to hand a metatype to pipes;
 * Zod wants a schema value. `createZodDto` bridges the two, so controllers
 * keep the familiar `@Body() dto: SignUpDto` signature while validation and
 * types both come from one schema.
 */
export interface ZodDto<TSchema extends z.ZodType = z.ZodType> {
  new (): z.output<TSchema>;
  readonly isZodDto: true;
  readonly schema: TSchema;
}

/**
 * ```ts
 * const signUpSchema = z.object({ email: z.email() }).strict();
 * class SignUpDto extends createZodDto(signUpSchema) {}
 * ```
 *
 * `.strict()` on the schema is what rejects unknown properties — the Zod
 * equivalent of `whitelist` + `forbidNonWhitelisted`, expressed where the
 * shape is already defined rather than as global pipe configuration.
 */
export function createZodDto<TSchema extends z.ZodType>(
  schema: TSchema,
): ZodDto<TSchema> {
  class ZodDtoClass {
    static readonly isZodDto = true;
    static readonly schema = schema;
  }

  return ZodDtoClass as unknown as ZodDto<TSchema>;
}

export function isZodDto(metatype: unknown): metatype is ZodDto {
  return (
    typeof metatype === 'function' &&
    (metatype as Partial<ZodDto>).isZodDto === true
  );
}
