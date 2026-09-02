# Dependency patches

One patch, and it should stay that way. A patch is a fork with better manners:
it survives only because `pnpm` reapplies it, and it is invisible to anyone
reading the dependency's own source. Prefer a supported option, then a version
bump, and reach for this only when neither exists.

## `@mastra/core@1.61.0`

Replaces exactly one statement, in the ESM and CJS copies of the same bundled
function, and changes nothing else:

```js
// before
console.error("Error converting tool call input to JSON", {
  input: value.input,
});
// after
console.error("Tool call input could not be parsed");
```

**What it is.** `convertFullStreamChunkToMastra` turns each AI SDK stream chunk
into a Mastra one. For a `tool-call` it parses the model's argument string, and
when both `JSON.parse` and `tryRepairJson` fail it prints the raw string.

**Why it matters here.** That string is model-generated text, composed after the
model was shown the caller's request and the organization's retrieved knowledge
passages. It is tenant material. The call is a bare global `console.error`
inside a pure transform — it takes no logger, its `ctx` carries only `runId`,
and nothing gates it — so the adapter's `containMastraAgent` cannot reach it and
Pino never sees it to redact it. It lands unredacted in worker container logs.

**Why it is reachable.** `tryRepairJson` fixes unquoted keys, single quotes,
trailing commas and bare dates. It cannot close a truncated object or string,
which is exactly what `maxOutputTokens` produces when a tool call is cut off
mid-argument. No adversary is required. Before this build had tools the branch
was unreachable, which is why the change that introduced tools owns the fix.

**Why a patch.** There is no supported alternative. The emission is
unconditional, exposed through no option or hook, and identical in `1.63.2` —
the newest release when this was written — so no version bump fixes it. Wrapping
the language model to sanitise arguments upstream would mean this application
constructing provider models itself and giving up Mastra's model resolution,
which is a far larger change than deleting one argument list.

**If it stops applying.** `pnpm` fails the install rather than continuing:
`ERR_PNPM_UNUSED_PATCH` on a normal install, `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`
on CI's frozen one. On a version bump, re-check whether upstream has fixed the
emission; if it has, delete the patch and its pin in `pnpm-workspace.yaml`. If
it has not, re-cut the patch with `pnpm patch @mastra/core@<version>`.

**What proves it.** `malformed tool-call arguments in application logs` in
`apps/backend/src/agents/runtime/mastra/__tests__/mastra.containment.spec.ts`
drives the real installed SDK down this exact branch with canaries in the
argument and asserts they reach no console sink. Reverting the patch fails it.
Two sibling tests assert valid and repairable calls still behave as before.
