import { describe, expect, it } from '@jest/globals';

import {
  MAX_CHUNK_CHARACTERS,
  chunkDocument,
} from '../../../../src/features/knowledge/chunking';

/**
 * The splitter, tested for the properties retrieval depends on.
 *
 * Every one of these would pass a "does it split" test and be a defect anyway:
 * a chunk over the bound is rejected by the provider, an empty chunk embeds to
 * a vector that matches everything equally badly, a lost ordinal means a
 * retrieved passage cannot be placed, and dropped text is material the
 * organization believes it has stored.
 */

const paragraph = (length: number, filler = 'a') => filler.repeat(length);

describe('chunkDocument', () => {
  it('produces no chunks for text with nothing in it', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('   \n\n  \t ')).toEqual([]);
  });

  it('keeps a short document as a single chunk', () => {
    const chunks = chunkDocument('One short paragraph.');

    expect(chunks).toEqual([{ ordinal: 0, content: 'One short paragraph.' }]);
  });

  it('splits on paragraph boundaries', () => {
    const text = `${paragraph(400, 'a')}\n\n${paragraph(400, 'b')}`;

    expect(chunkDocument(text)).toEqual([
      { ordinal: 0, content: paragraph(400, 'a') },
      { ordinal: 1, content: paragraph(400, 'b') },
    ]);
  });

  /**
   * A heading is a paragraph. Embedded alone it is a near-useless vector that
   * outranks the text it introduces for any query echoing its words, so it is
   * merged forward into what it heads.
   */
  it('merges a short paragraph into the one after it', () => {
    const chunks = chunkDocument(`Refund policy\n\n${paragraph(400, 'a')}`);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content.startsWith('Refund policy')).toBe(true);
  });

  it('never merges past the bound', () => {
    const chunks = chunkDocument(
      `short\n\n${paragraph(MAX_CHUNK_CHARACTERS, 'a')}`,
    );

    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARACTERS);
    }
  });

  it('breaks a long paragraph at sentence ends', () => {
    const sentence = `${paragraph(300, 'a')}. `;
    const chunks = chunkDocument(sentence.repeat(6));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARACTERS);
    }
    // Cut at a sentence end, not mid-word.
    for (const chunk of chunks) expect(chunk.content.endsWith('.')).toBe(true);
  });

  /**
   * Text with no punctuation at all — a table, a code block, a minified blob.
   * Without the hard split the function would either loop or emit a chunk the
   * provider refuses.
   */
  it('splits text that offers no sentence boundary at all', () => {
    const chunks = chunkDocument(paragraph(MAX_CHUNK_CHARACTERS * 3 + 17));

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARACTERS);
    }
  });

  it('never emits an empty chunk', () => {
    const inputs = [
      'a\n\n\n\nb',
      `${paragraph(MAX_CHUNK_CHARACTERS)}\n\n\n\n`,
      '.'.repeat(500),
      `\n\n${paragraph(2000)}\n\n`,
    ];

    for (const input of inputs) {
      const chunks = chunkDocument(input);

      // Guarded: a function returning nothing would satisfy the loop below
      // without ever entering it.
      expect(chunks.length).toBeGreaterThan(0);

      for (const chunk of chunks) {
        expect(chunk.content.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('numbers chunks from zero with no gaps', () => {
    const chunks = chunkDocument(
      Array.from({ length: 8 }, (_, index) => paragraph(400, `${index}`)).join(
        '\n\n',
      ),
    );

    // Both sides derive from `chunks`, so an empty result would satisfy this
    // without asserting anything about numbering.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_, index) => index),
    );
  });

  /**
   * The property that matters most and is easiest to break: the split must not
   * lose text. A dropped paragraph is material the organization believes it
   * has stored and an agent will never see.
   */
  it('keeps every non-whitespace character', () => {
    const text = [
      'Heading',
      paragraph(900, 'a'),
      `${paragraph(700, 'b')}. ${paragraph(700, 'c')}.`,
      paragraph(MAX_CHUNK_CHARACTERS * 2, 'd'),
    ].join('\n\n');

    const bare = (value: string) => value.replace(/\s+/g, '');

    expect(
      bare(
        chunkDocument(text)
          .map((chunk) => chunk.content)
          .join(''),
      ),
    ).toBe(bare(text));
  });

  /**
   * Re-chunking a chunk returns it unchanged.
   *
   * The previous form of this test compared two calls on the same input, which
   * a pure synchronous function cannot fail. This states the property that is
   * actually load-bearing: a chunk is already small enough and already whole,
   * so passing one back through must not split it further — which is what
   * makes re-ingestion of unchanged text produce an identical chunk set.
   */
  it('leaves an already-chunked passage alone', () => {
    const text = `${paragraph(900, 'a')}\n\n${paragraph(900, 'b')}`;
    const chunks = chunkDocument(text);

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const again = chunkDocument(chunk.content);

      expect(again).toHaveLength(1);
      expect(again[0]?.content).toBe(chunk.content);
    }
  });

  it('treats CRLF the same as LF', () => {
    const text = `${paragraph(400, 'a')}\n\n${paragraph(400, 'b')}`;

    expect(chunkDocument(text.replace(/\n/g, '\r\n'))).toEqual(
      chunkDocument(text),
    );
  });
});
