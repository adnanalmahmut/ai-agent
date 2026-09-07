/**
 * Stands in for the `server-only` package under Vitest.
 *
 * That package's entry point throws on purpose: it is what makes a build fail
 * when a client bundle reaches a server module. Vitest has no client graph to
 * fail, so importing the real one would only stop server code from being
 * testable at all. The boundary itself is asserted separately, by walking the
 * import graph in `src/lib/client-boundary.test.ts`.
 */
export {};
