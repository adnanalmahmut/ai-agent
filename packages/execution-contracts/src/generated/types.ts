/**
 * Generated from contracts/execution/v1 by scripts/generate.mjs.
 * Do not edit. Change the schema and run `pnpm execution:contracts`.
 */

/* eslint-disable */

/**
 * Any document the execution v1 contract defines.
 */
export type ExecutionV1Document =
  ArtifactRef | Embedding | RuntimeStepResult | RuntimeStep | SafeFailure | ToolInvocation;
/**
 * The contract this document is written against.
 */
export type ExecutionVersion = '1';
/**
 * An opaque identifier. The ceiling matches the idempotency-key bound the HTTP surface already enforces.
 */
export type ExecutionIdentifier = string;
/**
 * What a step produced. Exactly one of three shapes, told apart by `outcome`, so a reader never has to guess which fields are meaningful.
 */
export type RuntimeStepResult = RuntimeStepResultFinal | RuntimeStepResultToolRequest | RuntimeStepResultFailed;
/**
 * A delivery ordinal. Attempts start at one.
 */
export type ExecutionAttempt = number;
/**
 * Arbitrary agent data, bounded in width, depth and key naming. Total size is a separate budget the validator enforces, because JSON Schema cannot express bytes.
 */
export type ExecutionPayload =
  | string
  | number
  | boolean
  | null
  | ExecutionPayloadLevel5[]
  | {
      [k: string]: ExecutionPayloadLevel5;
    };
/**
 * A payload value with at most 5 further levels beneath it.
 */
export type ExecutionPayloadLevel5 =
  | string
  | number
  | boolean
  | null
  | ExecutionPayloadLevel4[]
  | {
      [k: string]: ExecutionPayloadLevel4;
    };
/**
 * A payload value with at most 4 further levels beneath it.
 */
export type ExecutionPayloadLevel4 =
  | string
  | number
  | boolean
  | null
  | ExecutionPayloadLevel3[]
  | {
      [k: string]: ExecutionPayloadLevel3;
    };
/**
 * A payload value with at most 3 further levels beneath it.
 */
export type ExecutionPayloadLevel3 =
  | string
  | number
  | boolean
  | null
  | ExecutionPayloadLevel2[]
  | {
      [k: string]: ExecutionPayloadLevel2;
    };
/**
 * A payload value with at most 2 further levels beneath it.
 */
export type ExecutionPayloadLevel2 =
  | string
  | number
  | boolean
  | null
  | ExecutionPayloadLevel1[]
  | {
      [k: string]: ExecutionPayloadLevel1;
    };
/**
 * A payload value with at most 1 further levels beneath it.
 */
export type ExecutionPayloadLevel1 =
  | string
  | number
  | boolean
  | null
  | ExecutionPayloadLevel0[]
  | {
      [k: string]: ExecutionPayloadLevel0;
    };
/**
 * The deepest level a payload may reach: scalars only.
 */
export type ExecutionPayloadLevel0 = string | number | boolean | null;
/**
 * A versioned tool reference, `id@version`.
 */
export type ExecutionToolRef = string;
/**
 * An instant, as an ISO-8601 date-time string. Never a language date object: those do not survive JSON.
 */
export type ExecutionTimestamp = string;

/**
 * A pointer to stored bytes. Deliberately not a URL and not a credential: resolving a reference is a service boundary's job, and a signed link placed here would outlive the authorization that made it.
 */
export interface ArtifactRef {
  version: ExecutionVersion;
  /**
   * An opaque storage reference the Control Plane can resolve.
   */
  ref: ExecutionIdentifier;
  /**
   * An IANA media type, without parameters.
   */
  contentType: string;
  /**
   * Size of the stored bytes. The ceiling is an explicit conservative one; no existing limit governs artifacts yet.
   */
  byteSize: number;
  /**
   * Lowercase hex SHA-256 of the stored bytes.
   */
  digest: string;
}
/**
 * A vector produced for a piece of text. The dimension is fixed, not advisory: the deployed pgvector column rejects anything else.
 */
export interface Embedding {
  version: ExecutionVersion;
  /**
   * The provider model identifier the vector came from.
   */
  model: string;
  /**
   * Exactly 1536 finite components.
   *
   * @minItems 1536
   * @maxItems 1536
   */
  vector: number[];
}
/**
 * The step finished and produced an answer.
 */
export interface RuntimeStepResultFinal {
  version: ExecutionVersion;
  stepId: ExecutionIdentifier;
  runId: ExecutionIdentifier;
  attempt: ExecutionAttempt;
  outcome: 'final';
  output: ExecutionPayload;
  /**
   * @maxItems 16
   */
  artifacts: ArtifactRef[];
}
/**
 * The step wants tools run before it can finish. Still a proposal.
 */
export interface RuntimeStepResultToolRequest {
  version: ExecutionVersion;
  stepId: ExecutionIdentifier;
  runId: ExecutionIdentifier;
  attempt: ExecutionAttempt;
  outcome: 'tool_request';
  /**
   * Proposals, bounded by the same per-attempt budget the in-process tool gateway enforces.
   *
   * @minItems 1
   * @maxItems 12
   */
  invocations: ToolInvocation[];
}
/**
 * A runtime asking for a tool to be run. A proposal and nothing more: there is no field here that can carry an authorization decision, and no extra property is accepted, so a runtime cannot invent one.
 */
export interface ToolInvocation {
  version: ExecutionVersion;
  invocationId: ExecutionIdentifier;
  tool: ExecutionToolRef;
  input: ExecutionPayload;
}
/**
 * The step could not produce an answer.
 */
export interface RuntimeStepResultFailed {
  version: ExecutionVersion;
  stepId: ExecutionIdentifier;
  runId: ExecutionIdentifier;
  attempt: ExecutionAttempt;
  outcome: 'failed';
  failure: SafeFailure;
}
/**
 * What went wrong, in terms both sides already agreed on. No stack, no raw error, no provider response: a failure crosses a trust boundary, and whatever it carries is the part an attacker gets to read.
 */
export interface SafeFailure {
  version: ExecutionVersion;
  /**
   * A closed vocabulary. Anything unrecognised is not a code.
   */
  code:
    | 'input_rejected'
    | 'output_rejected'
    | 'contract_violation'
    | 'configuration_error'
    | 'tool_unavailable'
    | 'provider_unavailable'
    | 'provider_rejected'
    | 'timeout'
    | 'cancelled'
    | 'internal_error';
}
/**
 * One unit of execution, described so a worker in any language can perform it. Everything it is pinned to was decided when the run was accepted; nothing here is a question the runtime gets to answer.
 */
export interface RuntimeStep {
  version: ExecutionVersion;
  stepId: ExecutionIdentifier;
  runId: ExecutionIdentifier;
  organizationId: ExecutionIdentifier;
  attempt: ExecutionAttempt;
  acceptedAt: ExecutionTimestamp;
  agent: {
    id: ExecutionIdentifier;
    version: ExecutionAttempt;
  };
  /**
   * The model pin, decided at acceptance.
   */
  model: {
    policyId: ExecutionIdentifier;
    modelId: ExecutionIdentifier;
    pricingRevisionId: ExecutionIdentifier;
  };
  input: ExecutionPayload;
  /**
   * Retrieved passages. The ceilings are the context policy the deployed agent definitions already use.
   *
   * @maxItems 12
   */
  context: {
    documentId: ExecutionIdentifier;
    chunkId: ExecutionIdentifier;
    text: string;
  }[];
  /**
   * Tools this step may propose. A reference the Control Plane did not put here is not made usable by asking for it.
   *
   * @maxItems 32
   */
  grantedTools: ExecutionToolRef[];
}
