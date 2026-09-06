/**
 * Regenerates `src/generated/` from `contracts/execution/v1/`.
 *
 * The JSON Schema documents are the authored source. This script only
 * orchestrates: inline them so the package carries its own contract rather
 * than reading files at runtime, and run `json-schema-to-typescript` over them
 * for the TypeScript view. It does not translate or reinterpret a schema; a
 * second opinion about the contract is exactly what this repository is trying
 * not to have.
 *
 * Nothing here touches a database, a broker or a network. The schemas are files.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from 'json-schema-to-typescript';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const contractsDirectory = fileURLToPath(
  new URL('../../../contracts/execution/v1/', import.meta.url),
);
const generatedDirectory = join(packageDirectory, 'src/generated');

const BANNER = `/**
 * Generated from contracts/execution/v1 by scripts/generate.mjs.
 * Do not edit. Change the schema and run \`pnpm execution:contracts\`.
 */`;

/** Stable ordering, so a regeneration is a diff about the contract only. */
const files = (await readdir(contractsDirectory))
  .filter((name) => name.endsWith('.schema.json'))
  .sort();

const documents = await Promise.all(
  files.map(async (name) => ({
    name,
    key: basename(name, '.schema.json'),
    schema: JSON.parse(await readFile(join(contractsDirectory, name), 'utf8')),
  })),
);

const identifierFor = (key) =>
  key.replace(/(^|-)([a-z])/g, (_, __, letter) => letter.toUpperCase());

// --- the schemas, inlined ----------------------------------------------------
const schemaEntries = documents
  .map(
    ({ key, schema }) =>
      `export const ${identifierFor(key)}Schema = ${JSON.stringify(
        schema,
        null,
        2,
      )} as const;`,
  )
  .join('\n\n');

const byId = documents
  .map(({ key, schema }) => `  [${JSON.stringify(schema.$id)}, ${identifierFor(key)}Schema],`)
  .join('\n');

await writeFile(
  join(generatedDirectory, 'schemas.ts'),
  `${BANNER}

/* eslint-disable */

${schemaEntries}

/** Every execution v1 document, addressed by \`$id\`. */
export const EXECUTION_V1_SCHEMAS: ReadonlyArray<readonly [string, object]> = [
${byId}
];
`,
);

// --- the TypeScript view -----------------------------------------------------
/**
 * One bundle, so a definition shared between documents becomes one named type
 * rather than the same union inlined at every use. This rebases `$ref`
 * targets and nothing else: no schema is rewritten, reinterpreted or dropped.
 */
const CONTRACT_BASE = 'https://contracts.ai-agent.local/execution/v1/';

const defsByKey = new Map();
/** Local `$defs` hoisted out of a document, prefixed so they cannot collide. */
const localNames = new Map();

for (const { key, schema } of documents) {
  if (key === 'common') {
    for (const [defKey, definition] of Object.entries(schema.$defs ?? {})) {
      defsByKey.set(defKey, definition);
    }

    continue;
  }

  const documentName = identifierFor(key);
  const { $defs: locals, ...rest } = schema;

  for (const [localKey, definition] of Object.entries(locals ?? {})) {
    const hoisted = `${documentName}${identifierFor(localKey)}`;

    localNames.set(`${documentName}#${localKey}`, hoisted);
    defsByKey.set(hoisted, definition);
  }

  defsByKey.set(documentName, rest);
}

const rebase = (node, documentName) => {
  if (Array.isArray(node)) {
    return node.map((item) => rebase(item, documentName));
  }
  if (node === null || typeof node !== 'object') return node;

  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      if (key === '$ref' && typeof value === 'string') {
        if (value.startsWith('#/$defs/')) {
          const local = value.slice('#/$defs/'.length);
          const hoisted = localNames.get(`${documentName}#${local}`);

          // A common definition is already a bundle-level name; only a
          // document's own local `$defs` were renamed on the way in.
          if (!hoisted && !defsByKey.has(local)) {
            throw new Error(`Unresolved local reference: ${value}`);
          }

          return [key, `#/$defs/${hoisted ?? local}`];
        }

        if (!value.startsWith(CONTRACT_BASE)) {
          throw new Error(`Unexpected reference outside the contract: ${value}`);
        }

        const [file, pointer] = value.slice(CONTRACT_BASE.length).split('#');
        const target = pointer
          ? pointer.replace('/$defs/', '')
          : identifierFor(basename(file, '.schema.json'));

        if (!defsByKey.has(target)) {
          throw new Error(`Reference to an unknown definition: ${value}`);
        }

        return [key, `#/$defs/${target}`];
      }

      // `$id` and `$schema` inside a bundled document would re-anchor it.
      if (key === '$id' || key === '$schema') return [key, undefined];

      return [key, rebase(value, documentName)];
    }).filter(([, value]) => value !== undefined),
  );
};

/** Which document a hoisted local came from, so its pointers still resolve. */
const ownerOf = new Map(
  [...localNames.entries()].map(([source, hoisted]) => [
    hoisted,
    source.split('#')[0],
  ]),
);

const bundleDefs = Object.fromEntries(
  [...defsByKey.entries()].map(([key, definition]) => [
    key,
    rebase(definition, ownerOf.get(key) ?? key),
  ]),
);

const topLevel = documents
  .filter(({ key }) => key !== 'common')
  .map(({ key }) => identifierFor(key));

if (topLevel.some((name) => !bundleDefs[name])) {
  throw new Error('A contract document is missing from the bundle');
}

const bundle = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'ExecutionV1Document',
  description: 'Any document the execution v1 contract defines.',
  anyOf: topLevel.map((name) => ({ $ref: `#/$defs/${name}` })),
  $defs: bundleDefs,
};

const declarations = await compile(bundle, 'ExecutionV1Document', {
  bannerComment: '',
  additionalProperties: false,
  declareExternallyReferenced: true,
  // A 1536-long tuple is not a useful type. The bound is real and the
  // validator enforces it; the TypeScript view says `number[]`.
  ignoreMinAndMaxItems: true,
  style: { singleQuote: true },
});

await writeFile(
  join(generatedDirectory, 'types.ts'),
  `${BANNER}

/* eslint-disable */

${declarations.trimEnd()}
`,
);

console.log(`Generated ${documents.length} execution v1 schemas.`);
