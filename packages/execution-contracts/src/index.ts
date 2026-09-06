/**
 * The execution wire contract, version 1.
 *
 * The authored source is `contracts/execution/v1/*.schema.json` — plain JSON
 * Schema, so a worker written in another language reads the same contract this
 * package does. Everything under `src/generated/` is produced from those files
 * by `pnpm execution:contracts`; there is no second, hand-kept description of
 * the same wire shape anywhere.
 *
 * This package deliberately knows nothing about NestJS, Prisma, a database, a
 * broker or a credential. It is types and validators over JSON.
 */
export const EXECUTION_CONTRACT_VERSION = '1' as const;

export type {
  ArtifactRef,
  Embedding,
  ExecutionPayload,
  ExecutionV1Document,
  RuntimeStep,
  RuntimeStepResult,
  RuntimeStepResultFailed,
  RuntimeStepResultFinal,
  RuntimeStepResultToolRequest,
  SafeFailure,
  ToolInvocation
} from './generated/types.js';

export {
  ArtifactRefSchema,
  EmbeddingSchema,
  EXECUTION_V1_SCHEMAS,
  RuntimeStepResultSchema,
  RuntimeStepSchema,
  SafeFailureSchema,
  ToolInvocationSchema
} from './generated/schemas.js';

export { jsonSafetyProblems } from './json-safe.js';
export type { JsonSafetyProblem, JsonValue } from './json-safe.js';

export {
  EXECUTION_CONTEXT_BUDGET_CODE_POINTS,
  EXECUTION_PAYLOAD_BUDGET_BYTES,
  validateArtifactRef,
  validateEmbedding,
  validateExecutionDocument,
  validateRuntimeStep,
  validateRuntimeStepResult,
  validateSafeFailure,
  validateToolInvocation
} from './validate.js';
export type {
  ContractIssue,
  ContractResult,
  ExecutionDocumentKind
} from './validate.js';

