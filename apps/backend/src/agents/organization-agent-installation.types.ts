import { z } from 'zod';

import type { AgentConfiguration } from '../ai/agents/agent.types';
import { TOOL_REFS, type ToolRef } from '../ai/tools/tool.types';
import { MODEL_ID_VALUES, type AgentModelId } from '../ai/models/model-catalog';

const agentIdSchema = z.string().trim().min(1).max(120);
const configurationSchema = z.record(z.string(), z.unknown());

/**
 * The tools an organization selects, by exact identity.
 *
 * `z.enum` over the code-owned list, so an unknown or misspelled tool is
 * refused at the request boundary rather than reaching a subset check. The
 * length bound is the registry's own size: a request naming more entries than
 * exist can only be duplicates or noise.
 *
 * Omitting the field means no tools, and on a replacement that means the new
 * version revokes whatever the previous one held. That is ordinary PUT
 * semantics — every other field on this body is a full statement of intent —
 * and it fails safe, since the only direction it can move is narrower. It is
 * stated plainly because "optional" reads as "leaves it alone", and here it
 * does not.
 */
const toolGrantsSchema = z.array(z.enum(TOOL_REFS)).max(TOOL_REFS.length);

export const createOrganizationAgentInstallationSchema = z
  .object({
    agentId: agentIdSchema,
    definitionVersion: z.number().int().positive(),
    enabled: z.boolean(),
    modelId: z.enum(MODEL_ID_VALUES).optional(),
    configuration: configurationSchema.optional(),
    toolGrants: toolGrantsSchema.optional(),
  })
  .strict();

export const replaceOrganizationAgentInstallationSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    definitionVersion: z.number().int().positive(),
    enabled: z.boolean(),
    modelId: z.enum(MODEL_ID_VALUES).optional(),
    configuration: configurationSchema,
    toolGrants: toolGrantsSchema.optional(),
  })
  .strict();

export const organizationAgentVersionQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

export type CreateOrganizationAgentInstallation = z.infer<
  typeof createOrganizationAgentInstallationSchema
>;

export type ReplaceOrganizationAgentInstallation = z.infer<
  typeof replaceOrganizationAgentInstallationSchema
>;

export type OrganizationAgentCatalogEntry = {
  agentId: string;
  latestDefinitionVersion: number;
  modelPolicyId: string;
  defaultModelId: AgentModelId;
  allowedModelIds: readonly AgentModelId[];
  defaultConfiguration: AgentConfiguration;
  /** The most this definition revision permits. An organization may narrow it. */
  maxToolGrants: readonly ToolRef[];
};

export type OrganizationAgentVersion = {
  id: string;
  organizationId: string;
  installationId: string;
  revision: number;
  definitionVersion: number;
  modelPolicyId: string | null;
  modelId: AgentModelId | null;
  enabled: boolean;
  configuration: AgentConfiguration;
  /** The exact tools this immutable version selected. */
  toolGrants: readonly ToolRef[];
  createdByUserId: string | null;
  createdAt: Date;
};

export type OrganizationAgentInstallation = {
  id: string;
  organizationId: string;
  agentId: string;
  revision: number;
  activeVersionId: string;
  activeVersion: OrganizationAgentVersion;
  createdAt: Date;
  updatedAt: Date;
};
