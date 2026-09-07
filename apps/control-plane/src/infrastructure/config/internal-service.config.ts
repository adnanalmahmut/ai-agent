import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * What one internal service may do. Deliberately a short closed list rather
 * than a grammar: a capability nobody has written down cannot be granted by
 * spelling it differently in an environment variable.
 */
export const INTERNAL_SERVICE_CAPABILITIES = [
  'execution:step.lease',
  'execution:step.settle',
] as const;

export type InternalServiceCapability =
  (typeof INTERNAL_SERVICE_CAPABILITIES)[number];

/**
 * Only the digest of a credential is configured, never the credential.
 *
 * The Control Plane never needs the token itself — it hashes what a caller
 * presented and compares — so an environment dump, a backup of it or an
 * operator reading it yields nothing that can be replayed against this
 * boundary.
 */
const credential = z.object({
  serviceId: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'serviceId may contain only lowercase letters, digits and "-"',
    ),
  tokenSha256: z
    .string()
    .regex(
      /^[0-9a-f]{64}$/,
      'tokenSha256 must be a lowercase SHA-256 hex digest',
    ),
  capabilities: z
    .array(z.enum(INTERNAL_SERVICE_CAPABILITIES))
    .min(1)
    .max(INTERNAL_SERVICE_CAPABILITIES.length),
});

const schema = z.object({
  // Absent means the boundary accepts nobody. A service surface that
  // authenticates by default only because it was left unconfigured is the
  // failure mode this default exists to remove.
  INTERNAL_SERVICE_CREDENTIALS: z
    .string()
    .default('[]')
    .transform((raw, ctx) => {
      let parsed: unknown;

      try {
        parsed = JSON.parse(raw === '' ? '[]' : raw);
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'INTERNAL_SERVICE_CREDENTIALS must be a JSON array',
        });

        return z.NEVER;
      }

      const credentials = z.array(credential).max(16).safeParse(parsed);

      if (!credentials.success) {
        ctx.addIssue({
          code: 'custom',
          message:
            'INTERNAL_SERVICE_CREDENTIALS entries must be ' +
            '{ serviceId, tokenSha256, capabilities }',
        });

        return z.NEVER;
      }

      const ids = new Set(credentials.data.map((entry) => entry.serviceId));

      if (ids.size !== credentials.data.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'INTERNAL_SERVICE_CREDENTIALS serviceIds must be unique',
        });

        return z.NEVER;
      }

      // One credential authenticating two services would make the digest
      // ambiguous, and the first match would silently decide identity.
      const digests = new Set(
        credentials.data.map((entry) => entry.tokenSha256),
      );

      if (digests.size !== credentials.data.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'INTERNAL_SERVICE_CREDENTIALS digests must be unique',
        });

        return z.NEVER;
      }

      return credentials.data;
    }),
});

export default registerAs('internalService', () => {
  const env = schema.parse(process.env);

  return { credentials: env.INTERNAL_SERVICE_CREDENTIALS };
});
