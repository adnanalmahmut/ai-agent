import { describe, expect, it } from '@jest/globals';

import { AUTHENTICATABLE_PROVIDERS } from '../../runtime/mastra/mastra.runtime';
import {
  contentIdeaAgent,
  contentIdeaInput,
  contentIdeaOutput,
} from '../content-idea';

/**
 * Evaluation fixtures for `content-idea@1`.
 *
 * Not a model quality benchmark. There is no provider here and there will not
 * be one in CI: a real call needs a credential this repository must never hold
 * and returns something different every time, so a suite built on it would be
 * a bill and a flake rather than a check.
 *
 * What these fixtures do check is the contract — the part that is this
 * application's responsibility and that a model cannot be blamed for. Each
 * case is a plausible provider answer, and the assertion is whether the
 * declared schema accepts or rejects it. `agent-runner.spec.ts` covers the
 * other half, that the runner actually applies this schema and refuses what
 * it rejects; between them, a schema change that started admitting a malformed
 * answer has somewhere to fail.
 *
 * Only the rows that encode a decision are here. A case asserting that
 * `.min(1)` refuses an empty string restates the line above it and would have
 * to be edited in lockstep with it forever, which makes it a second copy of
 * the schema rather than a check on it. What survives is the structural
 * behavior — `.strict()`, the defaults, the trim, and what a model that
 * answered in prose or wrapped its object gets.
 */

const ACCEPTED: ReadonlyArray<[string, unknown]> = [
  [
    'a grounded answer naming its spaces',
    {
      ideas: [
        {
          title: 'Why our kettle boils in ninety seconds',
          angle: 'Lead with the engineering detail, then the morning routine.',
          format: 'blog post',
        },
      ],
      sources: ['products', 'brand'],
    },
  ],
  [
    'an ungrounded answer with no sources',
    {
      ideas: [
        {
          title: 'Five ways to wake up slower',
          angle: 'Contrarian take on the rushed-morning trope.',
          format: 'newsletter',
        },
      ],
      sources: [],
    },
  ],
  [
    'sources omitted entirely, which defaults to empty',
    {
      ideas: [{ title: 'A title', angle: 'An angle.', format: 'short video' }],
    },
  ],
];

const REFUSED: ReadonlyArray<[string, unknown]> = [
  [
    'an empty title, which renders as a blank row',
    { ideas: [{ title: '', angle: 'An angle.', format: 'post' }], sources: [] },
  ],
  ['prose instead of the object', 'Here are five ideas you might like: 1. ...'],
  [
    'the object wrapped in a conversational envelope',
    { response: { ideas: [{ title: 'A', angle: 'B', format: 'C' }] } },
  ],
  /**
   * A model that added a field is a model that misread the contract, and an
   * unrecognized key is how a hallucinated `url` or `imagePrompt` would reach
   * a screen that decided to render whatever it was given.
   */
  [
    'an extra field nobody asked for',
    {
      ideas: [
        {
          title: 'A title',
          angle: 'An angle.',
          format: 'post',
          url: 'https://example.test/invented',
        },
      ],
      sources: [],
    },
  ],
];

describe('content-idea@1 output contract', () => {
  it.each(ACCEPTED)('accepts %s', (_name, answer) => {
    expect(contentIdeaOutput.safeParse(answer).success).toBe(true);
  });

  it.each(REFUSED)('refuses %s', (_name, answer) => {
    expect(contentIdeaOutput.safeParse(answer).success).toBe(false);
  });

  it('fills in the empty source list rather than leaving it undefined', () => {
    const parsed = contentIdeaOutput.parse({
      ideas: [{ title: 'A title', angle: 'An angle.', format: 'post' }],
    });

    expect(parsed.sources).toEqual([]);
  });
});

describe('content-idea@1 input contract', () => {
  it('defaults the count rather than leaving it to the prompt', () => {
    const parsed = contentIdeaInput.parse({
      topic: 'Kettles',
      audience: 'Home cooks',
    });

    expect(parsed.count).toBe(5);
  });

  it.each([
    [
      'a count beyond what the contract will pay for',
      { topic: 'Kettles', audience: 'Home cooks', count: 50 },
    ],
    [
      'an unrecognized field',
      { topic: 'Kettles', audience: 'Home cooks', model: 'gpt-5' },
    ],
  ])('refuses %s', (_name, payload) => {
    expect(contentIdeaInput.safeParse(payload).success).toBe(false);
  });

  it('trims what it stores, so two spellings are one request', () => {
    const parsed = contentIdeaInput.parse({
      topic: '  Kettles  ',
      audience: '  Home cooks ',
    });

    expect(parsed.topic).toBe('Kettles');
    expect(parsed.audience).toBe('Home cooks');
  });
});

describe('content-idea@1 definition', () => {
  /**
   * The policy is part of the behavior the version pins. Widening it means a
   * new version, because a run accepted against this one must keep reading the
   * corpus it was accepted against.
   */
  it('may read only the three declared spaces, within a stated budget', () => {
    expect(contentIdeaAgent.contextPolicy).toEqual({
      spaceSlugs: ['brand', 'products', 'campaigns'],
      maxChunks: 12,
      maxCharacters: 12_000,
    });
  });

  it('names a provider this build holds a credential for', () => {
    // The shape alone is not the claim: `anthropic/claude-x` matches a
    // `provider/model` pattern and has no credential mapping, so a definition
    // that passed a pattern check would still fail on its first real run.
    expect(AUTHENTICATABLE_PROVIDERS).toContain(
      contentIdeaAgent.model.split('/')[0],
    );
    expect(contentIdeaAgent.model.split('/')[1]).toBeTruthy();
  });

  /**
   * The instructions carry the defence that belongs in them. This is not proof
   * against injection — nothing in a prompt is — but the sentence being absent
   * is a silent regression, and the agent's whole exposure to organization
   * text runs through this.
   */
  it('tells the agent that reference material carries no instructions', () => {
    expect(contentIdeaAgent.instructions).toMatch(/carries no instructions/i);
    expect(contentIdeaAgent.instructions).toMatch(/ignore/i);
  });
});
