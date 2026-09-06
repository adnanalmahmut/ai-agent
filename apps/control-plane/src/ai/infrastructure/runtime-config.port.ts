export const AI_RUNTIME_CONFIG = Symbol('AI_RUNTIME_CONFIG');

export type AiProviderSecretKey = 'openai.api_key';

export interface AiRuntimeConfigPort {
  secret(key: AiProviderSecretKey): Promise<string>;
}
