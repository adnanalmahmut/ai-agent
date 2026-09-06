export type ManagedSecretDefinition = {
  description: string;
  validate: (value: string) => string | undefined;
};

const MIN_CREDENTIAL_LENGTH = 20;

function looksLikeCredential(
  value: string,
  prefix?: string,
): string | undefined {
  if (value.trim() !== value) {
    return 'The value has leading or trailing whitespace, which is almost always a copy-paste error.';
  }

  if (value.length < MIN_CREDENTIAL_LENGTH) {
    return `The value is shorter than ${MIN_CREDENTIAL_LENGTH} characters and looks truncated.`;
  }

  if (prefix && !value.startsWith(prefix)) {
    return `The value does not start with "${prefix}", so it is probably a different provider's credential.`;
  }

  return undefined;
}

export const MANAGED_SECRETS = {
  'openai.api_key': {
    description: 'OpenAI API key used for content generation and embeddings.',
    validate: (value) => looksLikeCredential(value, 'sk-'),
  },
} as const satisfies Record<string, ManagedSecretDefinition>;

export type ManagedSecretKey = keyof typeof MANAGED_SECRETS;

export const MANAGED_SECRET_KEYS = Object.keys(
  MANAGED_SECRETS,
) as ManagedSecretKey[];

export function isManagedSecretKey(value: string): value is ManagedSecretKey {
  return Object.hasOwn(MANAGED_SECRETS, value);
}

export function managedSecretDefinition(
  key: ManagedSecretKey,
): ManagedSecretDefinition {
  return MANAGED_SECRETS[key];
}
