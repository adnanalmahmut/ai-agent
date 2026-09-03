export const AI_RUNTIME_CONFIG = Symbol('AI_RUNTIME_CONFIG');

/** Provider credentials the generic AI runtime adapters are allowed to ask for. */
export type AiProviderSecretKey = 'openai.api_key';

export interface AiRuntimeConfigPort {
  secret(key: AiProviderSecretKey): Promise<string>;
}
