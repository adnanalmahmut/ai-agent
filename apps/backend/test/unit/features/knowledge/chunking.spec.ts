import { describe, expect, it } from '@jest/globals';

import {
  MAX_CHUNK_CHARACTERS,
  chunkDocument,
} from '../../../../src/features/knowledge/chunking';

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
    for (const chunk of chunks) expect(chunk.content.endsWith('.')).toBe(true);
  });

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

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_, index) => index),
    );
  });

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
