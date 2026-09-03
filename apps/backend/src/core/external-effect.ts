/** Bounded outcome of an idempotent call to an external provider. */
export type ExternalEffectOutcome =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'rejected' }
  | { kind: 'unavailable' };
