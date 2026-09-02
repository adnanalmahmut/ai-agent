import { describe, expect, it } from '@jest/globals';

import {
  KNOWLEDGE_SPACES,
  KNOWLEDGE_SPACE_SLUGS,
  isKnowledgeSpaceSlug,
  knowledgeSpaceDefinition,
} from '../../../../src/features/knowledge/knowledge-space.registry';

/**
 * The taxonomy is a contract, so the properties callers rely on are asserted
 * rather than assumed.
 *
 * Deliberately *not* a copy of the eight names. Which spaces exist is a product
 * decision, and pinning the list here would make adding one a test edit while
 * proving nothing — the registry would simply agree with its own transcription.
 * What is worth checking is the structure every consumer depends on: that the
 * guard is the only way in, that the derived list matches the table it is
 * derived from, and that no entry is missing the fields a screen renders.
 */
describe('knowledge space registry', () => {
  it('derives its slug list from the table itself', () => {
    expect([...KNOWLEDGE_SPACE_SLUGS].sort()).toEqual(
      Object.keys(KNOWLEDGE_SPACES).sort(),
    );
    expect(KNOWLEDGE_SPACE_SLUGS.length).toBeGreaterThan(0);
  });

  it('gives every space a name and a description', () => {
    for (const slug of KNOWLEDGE_SPACE_SLUGS) {
      const definition = knowledgeSpaceDefinition(slug);

      expect(definition.name.trim().length).toBeGreaterThan(0);
      expect(definition.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('accepts every registered slug', () => {
    for (const slug of KNOWLEDGE_SPACE_SLUGS) {
      expect(isKnowledgeSpaceSlug(slug)).toBe(true);
    }
  });

  it('refuses a slug that is not registered', () => {
    for (const candidate of [
      'brand',
      'Brand.Voice',
      'brand.voice ',
      'products',
      'anything-a-customer-invents',
      '',
    ]) {
      expect(isKnowledgeSpaceSlug(candidate)).toBe(false);
    }
  });

  /**
   * `Object.hasOwn`, not `in`.
   *
   * The registry is an object literal, so `'constructor' in it` is true. A
   * caller submitting `toString` as a slug would otherwise pass the guard and
   * reach a lookup that returns an inherited function where a definition should
   * be — and, further down, would be written to the database as a space slug.
   */
  it('refuses inherited object properties as slugs', () => {
    for (const inherited of [
      'constructor',
      'toString',
      'hasOwnProperty',
      '__proto__',
      'valueOf',
    ]) {
      expect(isKnowledgeSpaceSlug(inherited)).toBe(false);
    }
  });

  /**
   * Names come from here, never from a caller.
   *
   * The whole reason the create endpoint was removed is that a customer-supplied
   * name is text the application renders beside their own material for every
   * member of the organization. Asserting the registry is the source keeps that
   * a property of the code rather than a note in a review.
   */
  it('keeps names free of markup a screen would have to escape', () => {
    for (const slug of KNOWLEDGE_SPACE_SLUGS) {
      expect(knowledgeSpaceDefinition(slug).name).not.toMatch(/[<>]/);
    }
  });
});
