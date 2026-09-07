export function userInitials(name: string | null, email: string): string {
  const source = (name ?? '').trim() || localPart(email);
  const words = source.split(/\s+/).filter(Boolean).slice(0, 2);

  if (words.length === 0) return '';

  return words.map(firstCharacter).join('').toLocaleUpperCase();
}

function firstCharacter(word: string): string {
  const segmenter = new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  });

  for (const { segment } of segmenter.segment(word)) return segment;

  return '';
}

function localPart(email: string): string {
  const at = email.indexOf('@');
  return at === -1 ? email : email.slice(0, at);
}
