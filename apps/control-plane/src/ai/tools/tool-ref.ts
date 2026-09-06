export const TOOL_REFS = ['knowledge.search@1', 'notification.send@1'] as const;

export type ToolRef = (typeof TOOL_REFS)[number];

export function isToolRef(value: unknown): value is ToolRef {
  return (
    typeof value === 'string' &&
    (TOOL_REFS as readonly string[]).includes(value)
  );
}

export function toolRef(id: string, version: number): string {
  return `${id}@${version}`;
}
