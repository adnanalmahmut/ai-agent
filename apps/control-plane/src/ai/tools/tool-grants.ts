import { AgentConfigurationError } from '../agents/agent-configuration.error';
import type { AgentDefinition } from '../agents/agent.types';
import { ToolRegistry } from './tool.registry';
import { isToolRef, type ToolRef } from './tool.types';

/**
 * Which tools a run may use, decided from durable grants and the pinned
 * definition alone.
 *
 * This is the whole of the grant decision, kept apart from exposing anything
 * callable, because two places need the answer and only one of them is
 * allowed to hold an implementation: the in-process gateway builds executable
 * tools from it, while the execution document carries the references only.
 * A second copy of this rule would be a second place a tool could be widened.
 */
export function selectAuthorizedToolRefs(
  registry: ToolRegistry,
  definition: AgentDefinition,
  grants: readonly string[],
): readonly ToolRef[] {
  const maximum = new Set<ToolRef>(definition.maxToolGrants ?? []);
  const selected = new Set<ToolRef>();

  for (const grant of grants) {
    // Persisted grants are parsed rather than trusted.
    if (!isToolRef(grant) || !registry.has(grant)) {
      throw new AgentConfigurationError(
        `AgentRun organization version grants unknown tool "${grant}"`,
      );
    }
    if (!maximum.has(grant)) {
      throw new AgentConfigurationError(
        `AgentRun organization version grants tool "${grant}" outside its definition maximum`,
      );
    }
    selected.add(grant);
  }

  return [...selected];
}
