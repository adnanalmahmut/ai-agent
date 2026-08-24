/**
 * The knowledge taxonomy, owned by this application.
 *
 * Spaces are not something a customer invents. An agent's `ContextPolicy` names
 * the spaces it may read, in code, against a slug — so a free-form slug field
 * means the two halves of that contract are written by different people at
 * different times, and the failure mode is silent: a policy naming `brand.voice`
 * against an organization that typed `brand-voice` retrieves nothing at all and
 * reports no error, because "this slug resolves to no space" and "this space is
 * empty" are the same observation.
 *
 * Making the set closed turns that into a compile error. `KnowledgeSpaceSlug` is
 * a union of the eight keys below, `ContextPolicy.spaceSlugs` is typed as an
 * array of it, and a typo no longer type-checks. What the HTTP surface accepts
 * is narrowed the same way: there is no endpoint that defines a space, only one
 * that ensures a registered one exists, so an unknown slug cannot be persisted
 * through the application at all.
 *
 * The names here are the application's, not the customer's. A caller submitting
 * taxonomy metadata would be submitting the label an operator reads beside their
 * own material, which is a small injection surface for no benefit — the Platform
 * renders a translated name keyed on the slug instead.
 *
 * Deliberately not a generic taxonomy framework. Eight entries, a lookup, and a
 * guard. Custom spaces are not implemented, and adding one is a change to this
 * file plus whichever policy wants to read it.
 */

/** One registered space, as the application describes it. */
export type KnowledgeSpaceDefinition = {
  /**
   * The canonical English name, written to `KnowledgeSpace.name` whenever a row
   * is ensured.
   *
   * Stored rather than derived at read time so the row is self-describing to
   * anyone querying the database directly, and re-written on every ensure so a
   * rename here propagates rather than leaving old rows disagreeing with the
   * registry. It is not what the Platform displays: that comes from the
   * translation keyed on the slug.
   */
  name: string;
  /** What belongs in it, for the operator deciding where to put something. */
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

/**
 * Every registered slug, in a stable declared order.
 *
 * The listing surface returns the taxonomy in this order rather than sorting by
 * anything the database holds, so the screen reads the same for an organization
 * with one document as for one with a thousand.
 */
export const KNOWLEDGE_SPACE_SLUGS = Object.keys(
  KNOWLEDGE_SPACES,
) as readonly KnowledgeSpaceSlug[];

/**
 * `Object.hasOwn`, not `in`.
 *
 * `KNOWLEDGE_SPACES` is an object literal, so `'constructor' in it` is true. A
 * caller submitting `toString` would otherwise pass this guard and reach a
 * lookup that returns an inherited function where a definition should be.
 */
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
