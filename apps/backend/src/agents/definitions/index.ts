import type { AgentDefinition } from '../agent.types';
import { contentIdeaAgent } from './content-idea';

/**
 * Every agent this build can run, listed explicitly.
 *
 * No discovery, no directory scan, no plugin loading. The registry is built
 * from this array at startup and a run is pinned to an `(id, version)` pair,
 * so what can execute is a property of the deployed code rather than of what
 * happened to be on disk.
 */
export const PRODUCTION_AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  contentIdeaAgent,
];

export {
  contentIdeaAgent,
  contentIdeaInput,
  contentIdeaOutput,
  CONTENT_IDEA_AGENT_ID,
  CONTENT_IDEA_AGENT_VERSION,
} from './content-idea';
export type { ContentIdeaInput, ContentIdeaOutput } from './content-idea';
