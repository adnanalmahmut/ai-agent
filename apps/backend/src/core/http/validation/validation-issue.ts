import { HttpStatus } from '@nestjs/common';

/** Stable identifiers for field-level failures. */
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

export interface ValidationIssue {
  field: string;
  code: ValidationIssueCode;
  args?: Record<string, unknown>;
}

export class ValidationException extends Error {
  readonly status = HttpStatus.BAD_REQUEST;
  readonly code = 'VALIDATION_ERROR';

  constructor(readonly issues: ValidationIssue[]) {
    super('Validation failed');
    this.name = 'ValidationException';
  }
}
