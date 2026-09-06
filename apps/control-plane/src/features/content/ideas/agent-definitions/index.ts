import type { AgentDefinition } from '../../../../ai/agents/agent.types';
import { contentIdeaAgent } from './content-idea';

export const PRODUCTION_AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  contentIdeaAgent,
];

export {
  contentIdeaAgent,
  contentIdeaInput,
  contentIdeaOutput,
  contentIdeaOutputContract,
  CONTENT_IDEA_AGENT_ID,
  CONTENT_IDEA_AGENT_VERSION,
  CONTENT_IDEA_FORMATS,
  CONTENT_IDEA_LANGUAGES,
} from './content-idea';
export type {
  ContentIdeaFormat,
  ContentIdeaInput,
  ContentIdeaLanguage,
  ContentIdeaOutput,
} from './content-idea';
