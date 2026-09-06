import addFormats from 'ajv-formats';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { EXECUTION_V1_SCHEMAS } from './generated/schemas.js';
import type {
  ArtifactRef,
  Embedding,
  RuntimeStep,
  RuntimeStepResult,
  SafeFailure,
  ToolInvocation,
} from './generated/types.js';
import { jsonSafetyProblems } from './json-safe.js';

/**
 * The one limit the schema cannot state.
 *
 * JSON Schema bounds each field but has no notion of bytes, so a document can
 * satisfy every `maxLength` and still be enormous. This ceiling is the one the
 * deployment already enforces at its edge: `client_max_body_size 1m` in
 * infra/gateway/nginx/snippets/proxy-common.conf, matched by Better Auth's own
 * 1mb body limit. Nothing that could not reach the system should validate.
 */
export const EXECUTION_PAYLOAD_BUDGET_BYTES = 1_048_576;
export const EXECUTION_CONTEXT_BUDGET_CODE_POINTS = 12_000;

export type ContractIssue = {
  readonly path: string;
  readonly message: string;
};

export type ContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ContractIssue[] };

const CONTRACT_BASE = 'https://contracts.ai-agent.local/execution/v1/';

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  // The documents reference one another by `$id`; every one is registered.
  schemas: EXECUTION_V1_SCHEMAS.map(([, schema]) => schema),
});

addFormats(ajv, ['date-time']);

function compiled(id: string): ValidateFunction {
  const validate = ajv.getSchema(`${CONTRACT_BASE}${id}`);

  if (!validate) throw new Error(`Execution contract "${id}" is not registered`);

  return validate;
}

const VALIDATORS = {
  runtimeStep: compiled('runtime-step.schema.json'),
  runtimeStepResult: compiled('runtime-step-result.schema.json'),
  toolInvocation: compiled('tool-invocation.schema.json'),
  safeFailure: compiled('safe-failure.schema.json'),
  artifactRef: compiled('artifact-ref.schema.json'),
  embedding: compiled('embedding.schema.json'),
} as const;

export type ExecutionDocumentKind = keyof typeof VALIDATORS;

function issuesFrom(
  errors: readonly ErrorObject[] | null | undefined,
): ContractIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath === '' ? '/' : error.instancePath,
    message: error.message ?? 'is invalid',
  }));
}

/**
 * Checks a value against one execution v1 document, in three passes.
 *
 * JSON safety first, because a `Date` satisfies an object schema and then
 * serialises to something else. Then the byte budget, which no schema can
 * express. Then the schema itself. Each pass stops the next, so an issue list
 * describes one problem rather than the consequences of an earlier one.
 */
export function validateExecutionDocument<T>(
  kind: ExecutionDocumentKind,
  value: unknown,
): ContractResult<T> {
  const unsafe = jsonSafetyProblems(value);

  if (unsafe.length > 0) {
    return {
      ok: false,
      issues: unsafe.map(({ path, message }) => ({
        path: path === '' ? '/' : path,
        message,
      })),
    };
  }

  const size = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

  if (size > EXECUTION_PAYLOAD_BUDGET_BYTES) {
    return {
      ok: false,
      issues: [
        {
          path: '/',
          message: `document is ${size} bytes, over the ${EXECUTION_PAYLOAD_BUDGET_BYTES}-byte budget`,
        },
      ],
    };
  }

  const validate = VALIDATORS[kind];

  if (!validate(value)) return { ok: false, issues: issuesFrom(validate.errors) };

  if (kind === 'runtimeStep') {
    const step = value as RuntimeStep;
    let codePoints = 0;

    for (const passage of step.context ?? []) {
      codePoints += [...passage.text].length;
    }

    if (codePoints > EXECUTION_CONTEXT_BUDGET_CODE_POINTS) {
      return {
        ok: false,
        issues: [
          {
            path: '/context',
            message: `aggregate context is ${codePoints} code points, over the ${EXECUTION_CONTEXT_BUDGET_CODE_POINTS}-code-point budget`,
          },
        ],
      };
    }
  }

  return { ok: true, value: value as T };
}

export const validateRuntimeStep = (value: unknown) =>
  validateExecutionDocument<RuntimeStep>('runtimeStep', value);

export const validateRuntimeStepResult = (value: unknown) =>
  validateExecutionDocument<RuntimeStepResult>('runtimeStepResult', value);

export const validateToolInvocation = (value: unknown) =>
  validateExecutionDocument<ToolInvocation>('toolInvocation', value);

export const validateSafeFailure = (value: unknown) =>
  validateExecutionDocument<SafeFailure>('safeFailure', value);

export const validateArtifactRef = (value: unknown) =>
  validateExecutionDocument<ArtifactRef>('artifactRef', value);

export const validateEmbedding = (value: unknown) =>
  validateExecutionDocument<Embedding>('embedding', value);
