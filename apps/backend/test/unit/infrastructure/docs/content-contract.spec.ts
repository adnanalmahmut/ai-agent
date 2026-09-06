import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';

import { AppModule } from '../../../../src/api/app.module';
import { DEFAULT_APPLICATION_NAME } from '../../../../src/infrastructure/config';
import { createApplicationOpenApiDocument } from '../../../../src/infrastructure/docs';

/**
 * The documented Content Ideas, Content Projects and run-follow payloads.
 *
 * Platform reads these operations as generated TypeScript, so an operation the
 * document leaves as a bodiless response is one Platform has to describe for
 * itself — which is the second source of truth this contract exists to
 * prevent. Asserting the document is what makes that failure visible here
 * rather than as drift nobody notices.
 *
 * Preview mode builds the module graph and its route metadata without
 * instantiating a provider, so this needs no database, no Redis, no
 * credentials and no listener.
 */

type JsonSchema = {
  type?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
};

type Operation = {
  operationId?: string;
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    schema?: JsonSchema;
  }[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses: Record<
    string,
    { content?: Record<string, { schema?: JsonSchema }> } | undefined
  >;
};

const IDEAS = '/organizations/{organizationId}/content-ideas';
const PROJECTS = '/organizations/{organizationId}/content-projects';

let app: INestApplication;
let paths: Record<string, Record<string, Operation>>;

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`the document does not describe ${what}`);
  }

  return value;
}

const operation = (path: string, method: string): Operation =>
  must(must(paths[path], path)[method], `${method.toUpperCase()} ${path}`);

/** The `data` inside the documented success envelope, not the envelope. */
function successData(path: string, method: string, status: string): JsonSchema {
  const envelope = must(
    operation(path, method).responses[status]?.content?.['application/json']
      ?.schema,
    `a ${status} body for ${method.toUpperCase()} ${path}`,
  );

  expect(envelope.required).toEqual(['success', 'data', 'meta']);

  return must(envelope.properties?.data, `response data for ${path}`);
}

const requestSchema = (path: string, method: string): JsonSchema =>
  must(
    operation(path, method).requestBody?.content?.['application/json']?.schema,
    `a request body for ${method.toUpperCase()} ${path}`,
  );

const queryParameter = (path: string, method: string, name: string) =>
  must(
    (operation(path, method).parameters ?? []).find(
      (parameter) => parameter.in === 'query' && parameter.name === name,
    ),
    `a ${name} query parameter on ${method.toUpperCase()} ${path}`,
  );

/**
 * A documented header parameter. Names are matched case-insensitively because
 * HTTP header names are, and the document should not be the thing that decides
 * how a client spells one.
 */
const headerParameter = (path: string, method: string, name: string) =>
  must(
    (operation(path, method).parameters ?? []).find(
      (parameter) =>
        parameter.in === 'header' &&
        parameter.name.toLowerCase() === name.toLowerCase(),
    ),
    `a ${name} header on ${method.toUpperCase()} ${path}`,
  );

const keys = (schema: JsonSchema, what: string) =>
  Object.keys(must(schema.properties, what));

beforeAll(async () => {
  app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    bodyParser: false,
  });
  app.setGlobalPrefix('api');

  paths = createApplicationOpenApiDocument(app, DEFAULT_APPLICATION_NAME)
    .paths as unknown as Record<string, Record<string, Operation>>;
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('content payload contract', () => {
  it.each([
    [IDEAS, 'post', 'requestContentIdeas'],
    [`${IDEAS}/availability`, 'get', 'getContentIdeaAvailability'],
    [`${IDEAS}/{operationId}`, 'get', 'getContentIdeaOperation'],
    [`${PROJECTS}/from-idea`, 'post', 'createContentProjectFromIdea'],
    [PROJECTS, 'get', 'listContentProjects'],
    [`${PROJECTS}/{projectId}`, 'get', 'getContentProject'],
  ])('names %s %s as %s', (path, method, operationId) => {
    expect(operation(path, method).operationId).toBe(operationId);
  });

  describe('availability', () => {
    it('constrains the reason to the closed list, or null', () => {
      const data = successData(`${IDEAS}/availability`, 'get', '200');

      expect(keys(data, 'availability')).toEqual(['available', 'reason']);
      expect(data.properties?.reason?.anyOf).toEqual([
        {
          type: 'string',
          enum: [
            'agents_disabled',
            'content_ideas_disabled',
            'agent_not_installed',
            'agent_disabled',
          ],
        },
        { type: 'null' },
      ]);
    });
  });

  describe('requestContentIdeas', () => {
    it('describes the request body instead of an empty object', () => {
      const body = requestSchema(IDEAS, 'post');

      expect(keys(body, 'request body')).toEqual([
        'topic',
        'goal',
        'language',
        'audience',
        'guidance',
        'numberOfIdeas',
      ]);
      expect(body.required).toEqual(['topic', 'goal', 'language']);
      expect(body.properties?.language?.enum).toEqual(['ar', 'en']);
    });

    it('answers 201 with the same operation the status read answers with', () => {
      const accepted = successData(IDEAS, 'post', '201');
      const read = successData(`${IDEAS}/{operationId}`, 'get', '200');

      expect(accepted).toEqual(read);
    });
  });

  /**
   * Both create endpoints refuse a request without an idempotency key, so a
   * client that only reads the document has to be told. Leaving the header out
   * made the generated `parameters.header` `never`, which says the opposite of
   * what the handler does.
   */
  describe('the idempotency key both create endpoints require', () => {
    it.each([
      [IDEAS, 'post'],
      [`${PROJECTS}/from-idea`, 'post'],
    ])('is documented as required on %s %s', (path, method) => {
      expect(headerParameter(path, method, 'Idempotency-Key').required).toBe(
        true,
      );
    });

    it.each([
      [IDEAS, 'post'],
      [`${PROJECTS}/from-idea`, 'post'],
    ])('carries the bounds the handler enforces on %s %s', (path, method) => {
      // The same schema the controller parses the header with, so the document
      // cannot promise a key length the endpoint would reject.
      expect(
        headerParameter(path, method, 'Idempotency-Key').schema,
      ).toMatchObject({ type: 'string', minLength: 8, maxLength: 200 });
    });
  });

  describe('the followed run', () => {
    const read = () => successData(`${IDEAS}/{operationId}`, 'get', '200');

    it('carries the identifier, status, output and timestamps', () => {
      expect(keys(read(), 'operation')).toEqual([
        'id',
        'status',
        'output',
        'createdAt',
        'completedAt',
      ]);
    });

    it('constrains status to the run states the screen switches on', () => {
      expect(read().properties?.status?.enum).toEqual([
        'QUEUED',
        'RUNNING',
        'SUCCEEDED',
        'FAILED',
      ]);
    });

    it('leaves output null until a run has produced one', () => {
      expect(read().properties?.output?.anyOf).toEqual([
        expect.objectContaining({ type: 'object' }),
        { type: 'null' },
      ]);
    });

    it('describes the ideas a succeeded run carries', () => {
      const [output] = must(read().properties?.output?.anyOf, 'output');
      const idea = must(output.properties?.ideas?.items, 'an idea');

      expect(keys(idea, 'idea')).toEqual([
        'title',
        'hook',
        'angle',
        'summary',
        'suggestedFormat',
      ]);
      expect(idea.properties?.suggestedFormat?.enum).toEqual([
        'carousel',
        'post',
        'video',
      ]);
    });

    it('always sends sources, because the runner stores the parsed output', () => {
      const [output] = must(read().properties?.output?.anyOf, 'output');

      // The agent schema defaults `sources`; the stored value has already had
      // that default applied, so a reader never has to handle it missing.
      expect(output.required).toEqual(['ideas', 'sources']);
    });

    it('carries timestamps as ISO strings, not as dates', () => {
      expect(read().properties?.createdAt).toMatchObject({
        type: 'string',
        format: 'date-time',
      });
      expect(read().properties?.completedAt?.anyOf).toEqual([
        expect.objectContaining({ type: 'string', format: 'date-time' }),
        { type: 'null' },
      ]);
    });
  });

  describe('listContentProjects', () => {
    it.each(['cursor', 'limit'])('documents %s as optional', (name) => {
      expect(queryParameter(PROJECTS, 'get', name).required ?? false).toBe(
        false,
      );
    });

    it('gives cursor and limit their validated value types', () => {
      expect(queryParameter(PROJECTS, 'get', 'cursor').schema).toMatchObject({
        type: 'string',
      });
      expect(queryParameter(PROJECTS, 'get', 'limit').schema).toMatchObject({
        type: 'integer',
      });
    });

    it('documents a cursor page, not the envelope pagination model', () => {
      const data = successData(PROJECTS, 'get', '200');

      expect(keys(data, 'page')).toEqual(['items', 'nextCursor']);
      expect(data.properties?.items?.type).toBe('array');
    });

    it('lets the final page say there is nothing after it', () => {
      const data = successData(PROJECTS, 'get', '200');

      expect(data.properties?.nextCursor?.anyOf).toEqual([
        { type: 'string' },
        { type: 'null' },
      ]);
      // `nextCursor` is present on every page, null only on the last.
      expect(data.required).toEqual(['items', 'nextCursor']);
    });

    it('describes the projects inside the page', () => {
      const item = must(
        successData(PROJECTS, 'get', '200').properties?.items?.items,
        'a page item',
      );

      expect(keys(item, 'page item')).toEqual([
        'id',
        'organizationId',
        'sourceRunId',
        'sourceIdeaIndex',
        'title',
        'hook',
        'angle',
        'summary',
        'suggestedFormat',
        'language',
        'createdByUserId',
        'createdAt',
        'updatedAt',
      ]);
    });
  });

  describe('content project detail', () => {
    const detail = () => successData(`${PROJECTS}/{projectId}`, 'get', '200');

    it('is the list entry plus its brief and drafts', () => {
      const listItem = must(
        successData(PROJECTS, 'get', '200').properties?.items?.items,
        'a page item',
      );

      expect(keys(detail(), 'detail')).toEqual([
        ...keys(listItem, 'page item'),
        'brief',
        'drafts',
      ]);
    });

    it('answers the same detail whether a project was just created or read', () => {
      expect(successData(`${PROJECTS}/from-idea`, 'post', '201')).toEqual(
        detail(),
      );
    });

    it('describes the brief the project was promoted from', () => {
      const brief = must(detail().properties?.brief, 'a brief');

      expect(keys(brief, 'brief')).toEqual([
        'topic',
        'goal',
        'audience',
        'guidance',
      ]);
      // Only the topic and the goal are always answered for.
      expect(brief.required).toEqual(['topic', 'goal', 'audience', 'guidance']);
    });

    it('describes the drafts, whose body is null until one is authored', () => {
      const draft = must(detail().properties?.drafts?.items, 'a draft');

      expect(keys(draft, 'draft')).toEqual([
        'id',
        'revision',
        'title',
        'format',
        'language',
        'body',
        'createdAt',
      ]);
      expect(draft.properties?.body?.anyOf).toEqual([
        { type: 'string' },
        { type: 'null' },
      ]);
    });
  });

  describe('createContentProjectFromIdea', () => {
    it('describes the selection instead of an empty object', () => {
      const body = requestSchema(`${PROJECTS}/from-idea`, 'post');

      expect(keys(body, 'selection')).toEqual(['sourceRunId', 'ideaIndex']);
      expect(body.required).toEqual(['sourceRunId', 'ideaIndex']);
    });
  });
});
