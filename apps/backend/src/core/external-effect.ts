export type ExternalEffectOutcome =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'rejected' }
  | { kind: 'unavailable' };
