import { Injectable } from '@nestjs/common';
import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';

import { ValidationException } from './validation-issue';
import { isZodDto } from './zod-dto';
import { toValidationIssues } from './zod-issue-mapper';

/**
 * Global validation pipe.
 *
 * Anything that is not a `createZodDto` class passes through untouched, so
 * primitive `@Param`/`@Query` arguments and un-migrated handlers keep working.
 *
 * Notice what is *absent*: no language, no message, no response shape. The
 * pipe produces stable issue codes and hands them to the HTTP exception
 * filter, which is the single place that decides wording and serialization.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const { metatype } = metadata;

    if (!isZodDto(metatype)) {
      return value;
    }

    const result = metatype.schema.safeParse(value);

    if (!result.success) {
      throw new ValidationException(toValidationIssues(result.error, value));
    }

    // Returns the *parsed* output, so coercions and defaults declared in the
    // schema reach the handler — the Zod equivalent of `transform: true`.
    return result.data;
  }
}
