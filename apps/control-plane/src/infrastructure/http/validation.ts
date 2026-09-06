import {
  ArgumentMetadata,
  HttpStatus,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import type { z } from 'zod';

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

export function toValidationIssues(
  error: z.ZodError,
  input: unknown,
): ValidationIssue[] {
  return error.issues.flatMap((issue) => fromZodIssue(issue, input));
}

function fromZodIssue(
  issue: z.core.$ZodIssue,
  input: unknown,
): ValidationIssue[] {
  const field = issue.path.map(String).join('.');

  switch (issue.code) {
    case 'invalid_type': {
      // Zod reports a missing property and a wrong-typed property with the
      // same code, and the issue carries no `input`. Reading the original
      // payload at the failing path is what separates "you forgot this" from
      // "this is the wrong type" — a distinction users care about.
      const isMissing = valueAtPath(input, issue.path) === undefined;

      return [
        build(field, isMissing ? 'REQUIRED' : expectedTypeCode(issue.expected)),
      ];
    }

    case 'invalid_format':
      return [build(field, formatCode(issue.format), { format: issue.format })];

    case 'too_small':
      return [
        build(field, boundCode(issue.origin, 'min'), { min: issue.minimum }),
      ];

    case 'too_big':
      return [
        build(field, boundCode(issue.origin, 'max'), { max: issue.maximum }),
      ];

    case 'invalid_value':
      return [build(field, 'INVALID_ENUM')];

    case 'unrecognized_keys':
      // One issue lists every unknown key; the response addresses them
      // individually so a client can highlight each offending field. The
      // path prefix keeps nested keys addressable as `address.extra`.
      return issue.keys.map((key) =>
        build([field, key].filter(Boolean).join('.'), 'UNRECOGNIZED_KEY'),
      );

    default:
      return [build(field, 'INVALID_VALUE')];
  }
}

function build(
  field: string,
  code: ValidationIssueCode,
  args?: Record<string, unknown>,
): ValidationIssue {
  return { field, code, ...(args ? { args } : {}) };
}

function expectedTypeCode(expected: string): ValidationIssueCode {
  switch (expected) {
    case 'string':
      return 'INVALID_STRING';
    case 'number':
      return 'INVALID_NUMBER';
    case 'int':
    case 'bigint':
      return 'INVALID_INT';
    case 'boolean':
      return 'INVALID_BOOLEAN';
    case 'date':
      return 'INVALID_DATE';
    case 'array':
      return 'NOT_ARRAY';
    default:
      return 'INVALID_VALUE';
  }
}

function formatCode(format: string): ValidationIssueCode {
  switch (format) {
    case 'email':
      return 'INVALID_EMAIL';
    case 'uuid':
    case 'guid':
      return 'INVALID_UUID';
    case 'url':
      return 'INVALID_URL';
    case 'date':
    case 'datetime':
      return 'INVALID_DATE';
    case 'iso_date':
    case 'iso_datetime':
      return 'INVALID_DATE';
    default:
      return 'INVALID_FORMAT';
  }
}

function boundCode(origin: string, bound: 'min' | 'max'): ValidationIssueCode {
  if (origin === 'string') return bound === 'min' ? 'MIN_LENGTH' : 'MAX_LENGTH';
  if (origin === 'array') {
    return bound === 'min' ? 'ARRAY_MIN_SIZE' : 'ARRAY_MAX_SIZE';
  }
  return bound === 'min' ? 'MIN' : 'MAX';
}

function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let current = input;

  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }

  return current;
}

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const metatype = metadata.metatype;

    if (!metatype || !isZodDto(metatype)) {
      return value;
    }

    const schema = metatype.zodSchema;

    const result = schema.safeParse(value);

    if (result.success) {
      return result.data;
    }

    const issues = toValidationIssues(result.error, value);
    throw new ValidationException(issues);
  }
}
