import { z } from 'zod';

import type { AgentConfiguration } from './agent.types';
import {
  MODEL_ID_VALUES,
  type AgentModelId,
} from '../model-catalog/model-catalog';

const agentIdSchema = z.string().trim().min(1).max(120);
const configurationSchema = z.record(z.string(), z.unknown());

export const createOrganizationAgentInstallationSchema = z
  .object({
    agentId: agentIdSchema,
    definitionVersion: z.number().int().positive(),
    enabled: z.boolean(),
    modelId: z.enum(MODEL_ID_VALUES).optional(),
    configuration: configurationSchema.optional(),
  })
  .strict();

export const replaceOrganizationAgentInstallationSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    definitionVersion: z.number().int().positive(),
    enabled: z.boolean(),
    modelId: z.enum(MODEL_ID_VALUES).optional(),
    configuration: configurationSchema,
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
