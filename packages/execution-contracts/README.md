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

Validation runs in three passes, in this order:

1. **JSON safety.** A `Date`, a `BigInt`, a function, `NaN`, `undefined` or a
   class instance is rejected before a schema ever sees it. A `Date` has no own
   enumerable properties, so an object schema would accept it and the difference
   would only appear once it was serialised.
2. **Size.** One megabyte, matching the gateway's `client_max_body_size`. JSON
   Schema cannot express bytes, so this is separate on purpose.
3. **The schema.**

Each pass stops the next, so an issue list describes one problem rather than the
consequences of an earlier one.

## What this package is not

It has no dependency on NestJS, Prisma, a database, Redis or a credential, and
a test asserts that. It is types and validators over JSON, so a worker that
holds none of those can still speak the protocol.
