/** Every tool this build can execute, encoded as its durable identity. */
export const TOOL_REFS = ['knowledge.search@1', 'notification.send@1'] as const;

export type ToolRef = (typeof TOOL_REFS)[number];

export function isToolRef(value: unknown): value is ToolRef {
  return (
    typeof value === 'string' &&
    (TOOL_REFS as readonly string[]).includes(value)
  );
}

/** Composes the durable identity. The only place the `@` form is built. */
export function toolRef(id: string, version: number): string {
  return `${id}@${version}`;
}
