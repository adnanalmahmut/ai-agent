import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const NAME_MAX_LENGTH = 128;

const email = z
  .string()
  .trim()
  .min(1, { message: 'emailRequired' })
  .pipe(z.email({ message: 'emailInvalid' }));

const password = z
  .string()
  .min(1, { message: 'passwordRequired' })
  .min(PASSWORD_MIN_LENGTH, { message: 'passwordTooShort' })
  .max(PASSWORD_MAX_LENGTH, { message: 'passwordTooLong' });

const name = z
  .string()
  .trim()
  .min(1, { message: 'nameRequired' })
  .max(NAME_MAX_LENGTH, { message: 'nameTooLong' });

export const signInSchema = z.object({
  email,
  // Deliberately not `password`: an existing account created before a rule
  // changed must still be able to sign in, so the only client-side check is
  // that something was typed.
  password: z.string().min(1, { message: 'passwordRequired' }),
});

export const signUpSchema = z.object({
  name,
  email,
  password,
});

export const requestPasswordResetSchema = z.object({ email });

export const resetPasswordSchema = z
  .object({
    password,
    confirmPassword: z.string().min(1, { message: 'confirmPasswordRequired' }),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'passwordsDoNotMatch',
  });

export const resendVerificationSchema = z.object({ email });

export type SignInValues = z.infer<typeof signInSchema>;
export type SignUpValues = z.infer<typeof signUpSchema>;
export type RequestPasswordResetValues = z.infer<
  typeof requestPasswordResetSchema
>;
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

export type FieldIssues<T> = Partial<Record<keyof T & string, string>>;

export type ValidationResult<T> =
  | { readonly ok: true; readonly values: T }
  | { readonly ok: false; readonly issues: FieldIssues<T> };

export function validate<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): ValidationResult<z.infer<Schema>> {
  const parsed = schema.safeParse(input);

  if (parsed.success) return { ok: true, values: parsed.data };

  const issues: Record<string, string> = {};

  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field !== 'string' || field in issues) continue;
    issues[field] = issue.message;
  }

  // The keys were just read off this schema's own issue paths, which the
  // compiler cannot connect back to `keyof z.infer<Schema>`.
  return { ok: false, issues: issues as FieldIssues<z.infer<Schema>> };
}
