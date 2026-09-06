export const MAX_CHUNK_CHARACTERS = 1_200;

const MIN_CHUNK_CHARACTERS = 200;

export type Chunk = { ordinal: number; content: string };

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

function hardSplit(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARACTERS) return [text];

  const pieces: string[] = [];

  for (let start = 0; start < text.length; start += MAX_CHUNK_CHARACTERS) {
    pieces.push(text.slice(start, start + MAX_CHUNK_CHARACTERS));
  }

  return pieces;
}
