# Wire contracts

Schemas that more than one process has to agree on, written where no process
owns them.

Each contract is plain [JSON Schema](https://json-schema.org) (draft 2020-12).
That is the authored source. A worker written in Python or Go reads exactly the
same files a TypeScript caller does, which is the point: the moment a contract
lives inside one language's type system, every other reader is working from a
translation.

```text
contracts/
├── execution/v1/     the execution protocol, version 1
└── fixtures/         documents that must be accepted, and documents that must not
```

`packages/execution-contracts` generates a TypeScript view and validators from
`execution/v1`. It generates; it does not restate. Editing the generated output
is caught by `pnpm execution:contracts:check`, which regenerates before it
diffs — so only a change to a schema here can move it.

## Execution, version 1

Six documents:

| Document            | What it is                                                    |
| ------------------- | ------------------------------------------------------------- |
| `RuntimeStep`       | one unit of execution, with everything it is pinned to         |
| `RuntimeStepResult` | what the step produced: final, a tool request, or a failure    |
| `ToolInvocation`    | a runtime asking for a tool to be run — a proposal, no more    |
| `SafeFailure`       | what went wrong, in a closed vocabulary                        |
| `ArtifactRef`       | a pointer to stored bytes                                      |
| `Embedding`         | a vector, at the width the deployed column accepts             |

### How JSON is used

- **Dates** are ISO-8601 strings. Never a language date object: `new Date()`
  has no own enumerable properties, so an object schema accepts it and only
  serialisation reveals it was never the thing the schema described.
- **Numbers** are finite JSON numbers. No `NaN`, no `Infinity`, no `BigInt` —
  none of the three has a JSON literal, and each one either changes value or
  throws on the way out.
- **`undefined` never appears.** A property that has no value is omitted. The
  distinction between omitted and `null` is decided per field and stated in the
  schema; `SafeFailure.detail` is omitted when absent, and no field in v1 is
  nullable.
- **Every object is closed.** `additionalProperties: false` throughout, so a
  field nobody agreed on is a validation error rather than something a reader
  silently ignores and a writer silently depends on.
- **The version is explicit.** Every document carries `"version": "1"`.

### Bounds, and where they came from

Nothing here is a round number picked for the look of it. Each bound is either a
limit the deployment already enforces or an explicit conservative ceiling.

| Bound                          | Value       | Source                                                              |
| ------------------------------ | ----------- | ------------------------------------------------------------------- |
| identifier length              | 200         | the idempotency-key ceiling in `infrastructure/http/wire-codecs.ts`  |
| short text                     | 500         | `accountLifecycleReasonSchema`                                       |
| context passage text           | 12 000      | `contextPolicy.maxCharacters` on the deployed agent definition       |
| context passages per step      | 12          | `contextPolicy.maxChunks`                                            |
| tool invocations per result    | 12          | `MAX_TOOL_INVOCATIONS_PER_ATTEMPT` in `ai/tools/tool.gateway.ts`     |
| embedding width                | 1 536       | `EMBEDDING_DIMENSIONS`; the pgvector column rejects anything else    |
| attempt and version ceilings   | 2 147 483 647 | PostgreSQL `Int`, the column these are stored in                   |
| whole-document size            | 1 MiB       | `client_max_body_size 1m` at the gateway, and Better Auth's own 1mb  |
| granted tools per step         | 32          | conservative; two tool references exist today                        |
| artifacts per result           | 16          | conservative; no existing limit governs artifacts                    |
| artifact size                  | 64 MiB      | conservative; no existing limit governs artifacts                    |
| payload nesting depth          | 6           | conservative; deep enough for current agent output, and finite       |
| payload string / array / keys  | 65 536 / 256 / 128 | conservative, so no single field can approach the 1 MiB ceiling |

The document-size budget is the one bound JSON Schema cannot state, because it
has no notion of bytes. The validator enforces it separately, and a document can
satisfy every field bound and still fail it — which is the case the fixture
`too-large` exercises.

### Payloads

Agent input and output are arbitrary JSON, and stay arbitrary. What they are not
is unbounded: width, depth and key naming are all constrained, and the nesting
bound is written out level by level in `common.schema.json` rather than left to
a self-reference that no reader can stop following.

Property names matching the credential vocabulary — `password`, `token`,
`authorization`, `apiKey`, `secret`, `credential`, `privateKey`, `sessionId`,
`cookie`, `ciphertext` and their common spellings — are refused **at every
level**, not only the top one. A schema that only checked the surface would be
a check an attacker walks around by nesting once.

### Compatibility

Version 1 is the contract as published. The mechanical question behind every
rule below is the same: *does every document that was valid under the published
contract still validate?* `contracts/fixtures/execution/v1/valid` is that corpus,
and `packages/execution-contracts/test/compatibility.test.mjs` asks the question
against candidate changes.

Allowed inside v1:

- adding an **optional** property
- raising a ceiling or lowering a floor
- adding a member to a closed vocabulary
- adding a new document type

Requires v2, once a real consumer exists:

- removing a property, or making an optional one required
- narrowing a bound, or removing a vocabulary member
- changing a field's type
- changing what a field **means** while leaving its type alone — the one the
  corpus cannot catch, and the one to be most careful about
