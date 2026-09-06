export type KnowledgeSpaceDefinition = {
  name: string;
  description: string;
};

export const KNOWLEDGE_SPACES = {
  'organization.profile': {
    name: 'Organization profile',
    description:
      'Who the organization is: what it does, who it serves, and how it describes itself.',
  },
  'brand.identity': {
    name: 'Brand identity',
    description:
      'Positioning, values, and the claims the brand is willing to make.',
  },
  'brand.voice': {
    name: 'Brand voice',
    description:
      'Tone, vocabulary, and the way the brand writes when it speaks for itself.',
  },
  audience: {
    name: 'Audience',
    description:
      'Who the content is for: segments, needs, objections, and the language they use.',
  },
  'products.services': {
    name: 'Products and services',
    description:
      'What is offered, what each thing does, and what distinguishes it.',
  },
  'content.strategy': {
    name: 'Content strategy',
    description:
      'Themes, campaigns, channels, and what the content is meant to achieve.',
  },
  'design.system': {
    name: 'Design system',
    description:
      'Visual and interface conventions. Reference material for design work, not for prose.',
  },
  faq: {
    name: 'Frequently asked questions',
    description:
      'Questions the organization answers repeatedly, and its settled answers.',
  },
} as const satisfies Record<string, KnowledgeSpaceDefinition>;

export type KnowledgeSpaceSlug = keyof typeof KNOWLEDGE_SPACES;

export const KNOWLEDGE_SPACE_SLUGS = Object.keys(
  KNOWLEDGE_SPACES,
) as readonly KnowledgeSpaceSlug[];

export function isKnowledgeSpaceSlug(
  value: string,
): value is KnowledgeSpaceSlug {
  return Object.hasOwn(KNOWLEDGE_SPACES, value);
}

export function knowledgeSpaceDefinition(
  slug: KnowledgeSpaceSlug,
): KnowledgeSpaceDefinition {
  return KNOWLEDGE_SPACES[slug];
}
