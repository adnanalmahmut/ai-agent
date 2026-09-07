/**
 * Only what this surface reads.
 *
 * Deliberately not inferred from the Better Auth client: inferring it would
 * put the browser client in the import graph of every server module that
 * needs a session type, and the point of the split is that it is not there.
 */
export type AdminUser = {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
  banned?: boolean | null;
};

export type AdminSession = {
  user: AdminUser;
};
