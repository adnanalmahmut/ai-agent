/**
 * Compile-time test. It has no runtime assertions and is never executed; it
 * fails by not compiling, under `tsconfig.test-d.json`.
 *
 * What it pins is the one thing a runtime test cannot reach: the document kind,
 * not the caller, decides the type a successful result carries.
 */
import {
  validateArtifactRef,
  validateExecutionDocument,
  validateRuntimeStep,
  validateSafeFailure,
} from '../src/validate.js';
import type { ContractResult } from '../src/validate.js';
import type {
  ArtifactRef,
  RuntimeStep,
  SafeFailure,
} from '../src/generated/types.js';

type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const exact = <T extends true>(_proof: T): void => {};

const value: unknown = {};

const runtimeStep = validateExecutionDocument('runtimeStep', value);
const safeFailure = validateSafeFailure(value);
const artifactRef = validateArtifactRef(value);

// The kind chooses the result type.
exact<IsExact<typeof runtimeStep, ContractResult<RuntimeStep>>>(true);
exact<IsExact<typeof safeFailure, ContractResult<SafeFailure>>>(true);
exact<IsExact<typeof artifactRef, ContractResult<ArtifactRef>>>(true);
exact<
  IsExact<ReturnType<typeof validateRuntimeStep>, ContractResult<RuntimeStep>>
>(true);

// A kind's result is not assignable to another kind's result.
// @ts-expect-error -- `runtimeStep` does not validate a SafeFailure.
const mistyped: ContractResult<SafeFailure> = runtimeStep;

// A caller cannot name the type it wants.
type Unrelated = { readonly anything: string };
// @ts-expect-error -- the type argument is the kind, not the document type.
const lied = validateExecutionDocument<Unrelated>('runtimeStep', value);

// A kind that does not exist is rejected.
// @ts-expect-error -- "notADocument" is not an execution document kind.
const unknownKind = validateExecutionDocument('notADocument', value);

export type { Unrelated };
export { mistyped, lied, unknownKind };
