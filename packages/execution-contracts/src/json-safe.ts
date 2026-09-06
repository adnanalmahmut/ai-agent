/**
 * What JSON can actually carry.
 *
 * A schema validator sees a JavaScript value after the language has already
 * had its say. `new Date()` has no own enumerable properties, so an object
 * schema accepts it and then it serialises to a string nobody's schema
 * described. `NaN` serialises to `null`. A `bigint` throws on the way out. A
 * function disappears. Every one of those is a value that passed validation
 * and became something else on the wire, which is the failure this guards.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonSafetyProblem = {
  readonly path: string;
  readonly message: string;
};

const PLAIN_OBJECT_PROTOTYPES: ReadonlyArray<unknown> = [
  Object.prototype,
  null,
];

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return 'a bigint';
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'symbol') return 'a symbol';
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 'NaN' : 'a non-finite number';
  }
  if (value instanceof Date) return 'a Date object';
  return `a ${Object.prototype.toString.call(value).slice(8, -1)} instance`;
}

/**
 * Reports every value that would not survive `JSON.stringify` unchanged.
 * Returns an empty array when the input is already plain JSON.
 */
export function jsonSafetyProblems(value: unknown): JsonSafetyProblem[] {
  const problems: JsonSafetyProblem[] = [];
  const seen = new WeakSet<object>();

  const walk = (current: unknown, path: string): void => {
    if (current === null) return;

    const kind = typeof current;

    if (kind === 'string' || kind === 'boolean') return;

    if (kind === 'number') {
      if (Number.isFinite(current)) return;
      problems.push({ path, message: `${describe(current)} is not JSON` });

      return;
    }

    if (kind !== 'object') {
      problems.push({ path, message: `${describe(current)} is not JSON` });

      return;
    }

    const object = current as object;

    if (seen.has(object)) {
      problems.push({ path, message: 'a circular reference is not JSON' });

      return;
    }

    seen.add(object);

    if (Array.isArray(object)) {
      object.forEach((item, index) => {
        // A hole and an explicit `undefined` both serialise to `null`.
        if (item === undefined) {
          problems.push({
            path: `${path}[${index}]`,
            message: 'undefined is not JSON',
          });

          return;
        }

        walk(item, `${path}[${index}]`);
      });

      return;
    }

    if (!PLAIN_OBJECT_PROTOTYPES.includes(Object.getPrototypeOf(object))) {
      problems.push({ path, message: `${describe(object)} is not JSON` });

      return;
    }

    for (const [key, item] of Object.entries(object)) {
      // `JSON.stringify` drops these silently, so a reader would never learn
      // the sender meant to say something here.
      if (item === undefined) {
        problems.push({
          path: `${path}/${key}`,
          message: 'undefined is not JSON; omit the property instead',
        });

        continue;
      }

      walk(item, `${path}/${key}`);
    }
  };

  walk(value, '');

  return problems;
}
