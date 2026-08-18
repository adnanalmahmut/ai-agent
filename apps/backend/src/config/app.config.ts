import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),

  APP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  APP_NAME: z.string().default('API Service'),

  /**
   * Public base URL of the Platform application, mount point included.
   *
   * Needed because Better Auth deliberately does not generate organization
   * invitation URLs — the accept link points at a page the Platform owns, so
   * the address has to come from configuration rather than from a request
   * header an attacker could set.
   *
   * It replaces the former `APP_WEB_URL`, whose name said "the web front end"
   * while its only reader built a link into the Platform. Under the
   * single-origin deployment those are two different applications on one host
   * (`/` and `/platform`), so the ambiguous name was pointing invitation
   * emails at the marketing site. A path is expected here, not just an
   * origin: `https://www.example.com/platform`.
   */
  APP_PLATFORM_URL: z.url().default('http://localhost:3001/platform'),

  /**
   * How long to keep serving after readiness starts failing, before the HTTP
   * server is closed.
   *
   * Zero by default, which is right for local development and for the test
   * suites and wrong for Kubernetes. There, marking a pod not-ready and closing
   * its listener in the same tick loses the requests a load balancer sends in
   * between: endpoint removal propagates asynchronously, and a kubelet that has
   * not yet run the next readiness probe is still routing. The correct value is
   * roughly one probe interval plus the endpoint propagation delay — a few
   * seconds — and it belongs in the deployment manifest rather than in a default
   * that would slow every local restart to prove a point.
   */
  APP_SHUTDOWN_READINESS_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(0),

  /**
   * Hard deadline for the entire shutdown sequence.
   *
   * Must stay below the orchestrator's own termination grace period. A process
   * that gives up first exits having released what it could; one that overruns
   * is `SIGKILL`ed at an arbitrary point, which is how a half-written record
   * happens.
   */
  APP_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
});

export default registerAs('app', () => {
  const env = schema.parse(process.env);

  return {
    env: env.NODE_ENV,
    port: env.APP_PORT,
    name: env.APP_NAME,
    // Trailing slash removed once, here, so every consumer can concatenate.
    platformUrl: env.APP_PLATFORM_URL.replace(/\/+$/, ''),
    shutdown: {
      readinessDelayMs: env.APP_SHUTDOWN_READINESS_DELAY_MS,
      timeoutMs: env.APP_SHUTDOWN_TIMEOUT_MS,
    },
  };
});
