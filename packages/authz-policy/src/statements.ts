/**
 * A permission catalogue: each resource mapped to the actions it declares.
 * Better Auth calls these "statements".
 */
export type PermissionStatements = Readonly<Record<string, readonly string[]>>;

/**
 * One role's grants, constrained to the actions its catalogue declares. A
 * resource that is not in the catalogue, or an action the catalogue does not
 * list for that resource, is a compile error.
 */
export type RoleGrants<Statements extends PermissionStatements> = {
  readonly [Resource in keyof Statements]: readonly Statements[Resource][number][];
};
