import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';

import { ValidationException } from './validation-issue';
import { isZodDto } from './zod-dto';
import { toValidationIssues } from './zod-issue-mapper';

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
