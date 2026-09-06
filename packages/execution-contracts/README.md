# @repo/execution-contracts

The TypeScript view of `contracts/execution/v1`, plus validators.

The schemas are the source. Everything in `src/generated/` is produced from them
by `pnpm execution:contracts` and must not be edited: `pnpm
execution:contracts:check` regenerates before it diffs, so editing the output
proves nothing and only a schema change moves it.

```sh
pnpm execution:contracts        # regenerate from contracts/execution/v1
pnpm execution:contracts:check  # fail if the committed output is stale
```

## Using it

```ts
import { validateRuntimeStep, type RuntimeStep } from '@repo/execution-contracts';

const result = validateRuntimeStep(incoming);

if (!result.ok) return reject(result.issues);

const step: RuntimeStep = result.value;
```

Validation runs in four checks, in this order:

1. **JSON safety.** A `Date`, a `BigInt`, a function, `NaN`, `undefined` or a
   class instance is rejected before a schema ever sees it. A `Date` has no own
   enumerable properties, so an object schema would accept it and the difference
   would only appear once it was serialised.
2. **Document size.** One megabyte (`EXECUTION_PAYLOAD_BUDGET_BYTES`), matching
   the gateway's `client_max_body_size`. JSON Schema cannot express bytes, so
   this is separate on purpose.
3. **The schema.** Validated against the strict JSON Schema Draft 2020-12
   definition. Protocol/envelope objects are closed
   (`additionalProperties: false`); `ExecutionPayload` remains arbitrary bounded
   JSON, so payload objects may carry bounded additional properties — subject to
   the depth, width and sensitive-property-name rules — and JSON `null` is a
   valid payload value. Protocol/envelope fields are non-nullable unless a schema
   declares otherwise.
4. **Aggregate context budget.** For `RuntimeStep`, the sum of Unicode code
   points across all passages in `context` cannot exceed 12 000
   (`EXECUTION_CONTEXT_BUDGET_CODE_POINTS`). JSON Schema cannot sum lengths
   across array items.

Each pass stops the next, so an issue list describes one problem rather than the
consequences of an earlier one.

## Compatibility model

Version 1 is the contract as published. Before RF-16, v1 is pre-consumer and can
be corrected to harden trust boundaries. Once the first real consumer exists,
emitted wire shapes are frozen.

- **Backward reader compatibility:** Newer readers accept older documents as
  long as added fields are optional.
- **Rolling forward compatibility:** Because v1 protocol/envelope objects are
  closed (`additionalProperties: false`) and enums are closed, adding fields or
  enum values is **not** forward-compatible without coordinated phased
  deployment.

## What this package is not

It has no dependency on NestJS, Prisma, a database, Redis or a credential, and
a test asserts that. It is types and validators over JSON, so a worker that
holds none of those can still speak the protocol.
