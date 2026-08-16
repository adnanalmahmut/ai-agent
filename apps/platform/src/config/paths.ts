/**
 * Where the three applications sit on the single production origin.
 *
 * These are deployment *facts*, not configuration. Production serves
 * everything from one host behind one reverse proxy:
 *
 *   https://www.example.com/           → the marketing web application
 *   https://www.example.com/platform/* → this application
 *   https://www.example.com/api/*      → the NestJS backend
 *   https://www.example.com/api/auth/* → Better Auth, inside the backend
 *
 * Because the browser and the API share an origin, none of this needs to be an
 * environment variable — there is no host to configure, only a path, and a
 * path that changed would break the reverse proxy and the router together.
 * Making it a `VITE_` variable would publish a value that can never vary while
 * suggesting it can.
 *
 * This module deliberately imports nothing: `vite.config.ts` reads it for the
 * build's `base`, the router reads it for its `basename`, and the auth client
 * reads it for its API prefix. One definition, three consumers, no drift.
 */

/** Public path this SPA is served from. Matches Vite's `base`. */
export const PLATFORM_BASE_PATH = '/platform';

/** Public path of the backend. Same origin, so a path is the whole address. */
export const API_BASE_PATH = '/api';

/** Better Auth's mount point inside the backend. */
export const AUTH_BASE_PATH = `${API_BASE_PATH}/auth`;
