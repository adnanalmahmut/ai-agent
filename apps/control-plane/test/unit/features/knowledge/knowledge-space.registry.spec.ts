import { describe, expect, it } from '@jest/globals';

import {
  KNOWLEDGE_SPACES,
  KNOWLEDGE_SPACE_SLUGS,
  isKnowledgeSpaceSlug,
  knowledgeSpaceDefinition,
} from '../../../../src/features/knowledge/knowledge-space.registry';

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

  it('keeps names free of markup a screen would have to escape', () => {
    for (const slug of KNOWLEDGE_SPACE_SLUGS) {
      expect(knowledgeSpaceDefinition(slug).name).not.toMatch(/[<>]/);
    }
  });
});
