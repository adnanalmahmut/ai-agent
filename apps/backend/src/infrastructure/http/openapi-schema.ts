import type { ApiResponseSchemaHost } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * The schema type Nest's response and body decorators accept. Nest does not
 * export `SchemaObject` from its public entry, so it is read off the options
 * type that is exported.
 */
type OpenApiSchema = ApiResponseSchemaHost['schema'];

/**
 * A Zod schema's wire representation, as an OpenAPI schema object.
 *
 * `io: 'input'` is what selects the wire side. For a schema built from codecs
 * the input is the JSON that crosses HTTP and the output is the value the
 * application works with, so one schema describes both and this function asks
 * for the former.
 *
 * The assertion reconciles two TypeScript descriptions of the same JSON
 * document: Zod's `JSONSchema` models boolean subschemas such as
 * `not: false`, which Nest's narrower `SchemaObject` does not express.
 */
export function wireSchemaOf(schema: z.ZodType): OpenApiSchema {
  const jsonSchema = z.toJSONSchema(schema, { io: 'input' });

  // OpenAPI 3.1 declares the dialect once for the whole document.
  delete jsonSchema.$schema;

  return jsonSchema as OpenApiSchema;
}

/**
 * One payload schema wrapped in the envelope `ResponseInterceptor` adds to
 * successful responses, so a documented operation describes the body a client
 * actually receives rather than the controller's inner return value.
 *
 * This describes the response. Nothing validates it at runtime.
 */
export function apiSuccessSchema(data: z.ZodType): OpenApiSchema {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean', enum: [true] },
      data: wireSchemaOf(data),
      meta: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
        required: ['requestId', 'timestamp'],
      },
    },
    required: ['success', 'data', 'meta'],
  };
}
