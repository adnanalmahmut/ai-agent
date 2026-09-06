export { HttpInfrastructureModule } from './http.module';
export {
  configureTrustedProxy,
  overwriteDirectClientIpHeaders,
} from './client-ip';

export { createZodDto, isZodDto, toValidationIssues } from './validation';
export {
  VALIDATION_ISSUE_CODES,
  ValidationException,
  ZodValidationPipe,
} from './validation';
export type {
  ValidationIssue,
  ValidationIssueCode,
  ZodDto,
} from './validation';

export { apiSuccessSchema, wireSchemaOf } from './openapi-schema';

export { UnifiedExceptionFilter } from './errors';

export {
  IS_RAW_RESPONSE_KEY,
  RawResponse,
  ResponseInterceptor,
} from './response';
export type {
  ApiBusinessErrorDetails,
  ApiErrorDetail,
  ApiErrorDetails,
  ApiErrorResponse,
  ApiFieldError,
  ApiValidationErrorDetails,
  ApiMeta,
  ApiResponse,
  ApiSuccessResponse,
  PaginationMeta,
} from './response';
