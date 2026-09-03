import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { APPLICATION_TOOL_DEFINITIONS } from '../../../../src/features/agent-management/tools/definitions';
import { ToolRegistry } from '../../../../src/ai/tools/tool.registry';
import { RUNTIME_TOOL_NAME_PATTERN } from '../../../../src/ai/agents/agent.types';
import {
  TOOL_REFS,
  type ToolDefinition,
} from '../../../../src/ai/tools/tool.types';

const valid = (overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  id: 'knowledge.search',
  version: 1,
  runtimeName: 'knowledge_search_v1',
  description: 'Search knowledge.',
  input: z.object({ query: z.string() }).strict(),
  output: z.object({ passages: z.array(z.string()) }).strict(),
  risk: 'read_only',
  ...overrides,
});

/**
 * The second declared reference, so a registry built from `valid()` alone is
 * not refused for the unrelated reason that `notification.send@1` is missing.
 */
const sideEffect = (): ToolDefinition => ({
  id: 'notification.send',
  version: 1,
  runtimeName: 'notification_send_v1',
  description: 'Propose a notification.',
  input: z.object({ recipientMemberId: z.string() }).strict(),
  output: z.object({ status: z.literal('awaiting_approval') }).strict(),
  risk: 'side_effect',
});

const registryOf = (...definitions: ToolDefinition[]) =>
  new ToolRegistry([...definitions, sideEffect()]);

describe('ToolRegistry composition', () => {
  it('registers the production tool set', () => {
    const registry = new ToolRegistry(APPLICATION_TOOL_DEFINITIONS);

    expect(registry.refs()).toEqual([...TOOL_REFS]);
    expect(registry.resolve('knowledge.search@1').risk).toBe('read_only');
    expect(registry.resolve('notification.send@1').risk).toBe('side_effect');
  });

  it('refuses a duplicate exact identity', () => {
    // Distinct runtime names, so this reaches the identity check rather than
    // being caught earlier as a name collision.
    expect(() =>
      registryOf(valid(), valid({ runtimeName: 'knowledge_search_v1_again' })),
    ).toThrow('Duplicate tool "knowledge.search@1"');
  });

  it('refuses two tools offered to the model under one name', () => {
    expect(() => registryOf(valid(), valid())).toThrow(
      'Duplicate tool runtime name "knowledge_search_v1"',
    );
  });

  /**
   * The whole point of pinning: two registrations of one `(id, version)` make
   * a stored grant and a stored `ToolExecution` ambiguous.
   */
  it('distinguishes versions of one tool id', () => {
    expect(() =>
      registryOf(
        valid(),
        valid({ version: 2, runtimeName: 'knowledge_search_v2' }),
      ),
    ).toThrow('Tool "knowledge.search@2" is not a declared tool reference');
  });

  it.each([
    [{ version: 0 }, 'invalid version'],
    [{ version: -1 }, 'invalid version'],
    [{ version: 1.5 }, 'invalid version'],
    [{ id: '' }, 'not a valid identity'],
    [{ id: '  padded  ' }, 'not a valid identity'],
  ])('refuses an invalid identity %p', (overrides, message) => {
    expect(() => new ToolRegistry([valid(overrides)])).toThrow(message);
  });

  it('refuses an unknown reference that is not declared', () => {
    expect(() => registryOf(valid({ id: 'invented.tool' }))).toThrow(
      'Tool "invented.tool@1" is not a declared tool reference',
    );
  });

  /** The other direction: a declared reference nothing implements. */
  it('refuses a build whose declared reference has no definition', () => {
    expect(() => new ToolRegistry([])).toThrow(
      'Tool "knowledge.search@1" is not registered',
    );
  });

  it('refuses an invalid risk classification', () => {
    expect(() => registryOf(valid({ risk: 'destructive' as never }))).toThrow(
      'invalid risk classification',
    );
  });

  it.each([[''], ['   '], ['x'.repeat(501)]])(
    'refuses an unusable description %p',
    (description) => {
      expect(() => registryOf(valid({ description }))).toThrow(
        'invalid description',
      );
    },
  );

  /**
   * The SDK would not reject these names — it would rewrite them, which is the
   * silent failure this check exists to convert into a loud one.
   */
  it.each([
    ['knowledge.search@1'],
    ['knowledge search'],
    ['1_leading_digit'],
    ['-leading-dash'],
    ['x'.repeat(64)],
  ])('refuses a runtime name an SDK would rewrite: %p', (runtimeName) => {
    expect(() => registryOf(valid({ runtimeName }))).toThrow(
      'runtime name an SDK would rewrite',
    );
  });

  it('accepts the production runtime names unaltered', () => {
    for (const definition of APPLICATION_TOOL_DEFINITIONS) {
      expect(RUNTIME_TOOL_NAME_PATTERN.test(definition.runtimeName)).toBe(true);
    }
  });

  it('resolves nothing for an unregistered reference', () => {
    const registry = new ToolRegistry(APPLICATION_TOOL_DEFINITIONS);

    expect(() => registry.resolve('invented@1' as never)).toThrow(
      'is not registered',
    );
    expect(registry.has('invented@1' as never)).toBe(false);
  });

  it('freezes what it hands out', () => {
    const registry = new ToolRegistry(APPLICATION_TOOL_DEFINITIONS);
    const definition = registry.resolve('knowledge.search@1');

    expect(Object.isFrozen(definition)).toBe(true);
  });
});
