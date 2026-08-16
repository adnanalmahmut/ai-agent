/**
 * Machine-readable vocabulary for request validation failures.
 *
 * Mirrors the `AppErrorCode` idea one level down: the validation layer states
 * *what* is wrong with a field in a stable, language-free code, and the HTTP
 * boundary decides how to phrase it. Clients branch on `code`; `message` is
 * presentation only.
 *
 * This list is the *only* vocabulary the validation layer speaks. A new kind
 * of failure is expressed by adding a code here — never by letting a schema
 * smuggle a translation key through, which would put a typo like
 * `validation.MIN_LENGHT` beyond the reach of the generated key types.
 */
export const VALIDATION_ISSUE_CODES = [
  'REQUIRED',
  'INVALID_STRING',
  'INVALID_NUMBER',
  'INVALID_INT',
  'INVALID_BOOLEAN',
  'INVALID_DATE',
  'INVALID_EMAIL',
  'INVALID_UUID',
  'INVALID_URL',
  'INVALID_FORMAT',
  'INVALID_ENUM',
  'INVALID_VALUE',
  'MIN_LENGTH',
  'MAX_LENGTH',
  'MIN',
  'MAX',
  'NOT_ARRAY',
  'ARRAY_MIN_SIZE',
  'ARRAY_MAX_SIZE',
  'UNRECOGNIZED_KEY',
] as const;

export type ValidationIssueCode = (typeof VALIDATION_ISSUE_CODES)[number];

export type ValidationIssue = {
  /** Dotted path, so nested objects and arrays stay addressable: `address.city`, `tags.0`. */
  field: string;
  code: ValidationIssueCode;
  /** Interpolation values for the localized message, e.g. `{ min: 8 }`. */
  args?: Record<string, unknown>;
};

/**
 * Thrown by `ZodValidationPipe`, translated by the HTTP exception filter.
 *
 * Deliberately not an `HttpException`: like `AppException`, it carries facts,
 * not a status code, a language, or a response shape.
 */
export class ValidationException extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super('VALIDATION_ERROR');
    this.name = 'ValidationException';
  }
}
