/**
 * Splitting a document into passages worth embedding.
 *
 * Deliberately boring and deliberately pure: no tokenizer, no model, no
 * network. A tokenizer would tie chunking to one provider's vocabulary and
 * make the split change under us on a model upgrade, which would silently
 * alter what an agent reads. Characters are a coarser measure and a stable
 * one, and the bound below is chosen so a chunk fits comfortably inside every
 * embedding model this application could plausibly use.
 *
 * Paragraph-first, because a paragraph is the smallest unit that usually
 * carries a complete thought. Splitting on a fixed width instead would cut
 * sentences in half and embed the halves, which is how retrieval starts
 * returning passages that are individually meaningless.
 */

/** Big enough to hold an idea, small enough that several fit in a context. */
export const MAX_CHUNK_CHARACTERS = 1_200;

/**
 * Below this, a paragraph is merged into the one after it.
 *
 * A heading on its own line is a paragraph, and embedded alone it is a
 * near-useless vector that outranks the text it introduces for any query
 * echoing its words. Merging keeps the heading with what it heads.
 */
const MIN_CHUNK_CHARACTERS = 200;

export type Chunk = { ordinal: number; content: string };

/**
 * Splits text into ordered chunks.
 *
 * Total function: any input produces a valid result, and empty input produces
 * no chunks rather than one empty chunk — an empty passage embeds to a vector
 * that means nothing and matches everything equally badly.
 */
export function chunkDocument(text: string): Chunk[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const merged: string[] = [];

  for (const paragraph of paragraphs) {
    const previous = merged[merged.length - 1];

    if (
      previous !== undefined &&
      previous.length < MIN_CHUNK_CHARACTERS &&
      previous.length + paragraph.length + 2 <= MAX_CHUNK_CHARACTERS
    ) {
      merged[merged.length - 1] = `${previous}\n\n${paragraph}`;
      continue;
    }

    merged.push(paragraph);
  }

  return merged
    .flatMap((paragraph) => splitLongParagraph(paragraph))
    .map((content, ordinal) => ({ ordinal, content }));
}

/**
 * A paragraph longer than the bound is broken at sentence ends, and only at a
 * hard character boundary when a single "sentence" is itself too long — which
 * in practice means a table, a code block, or text with no punctuation at all.
 */
function splitLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHUNK_CHARACTERS) return [paragraph];

  const sentences = paragraph.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) ?? [
    paragraph,
  ];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    for (const piece of hardSplit(sentence)) {
      if (current.length + piece.length > MAX_CHUNK_CHARACTERS && current) {
        chunks.push(current.trim());
        current = '';
      }
      current += piece;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/** The last resort, so the function terminates on text with no punctuation. */
function hardSplit(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARACTERS) return [text];

  const pieces: string[] = [];

  for (let start = 0; start < text.length; start += MAX_CHUNK_CHARACTERS) {
    pieces.push(text.slice(start, start + MAX_CHUNK_CHARACTERS));
  }

  return pieces;
}
