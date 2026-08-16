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
});

export default registerAs('app', () => {
  const env = schema.parse(process.env);

  return {
    env: env.NODE_ENV,
    port: env.APP_PORT,
    name: env.APP_NAME,
    // Trailing slash removed once, here, so every consumer can concatenate.
    platformUrl: env.APP_PLATFORM_URL.replace(/\/+$/, ''),
  };
});
