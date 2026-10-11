// Matches an Open Library search candidate against a torrent name, so a library book that arrived
// without metadata can be given a title (and author) it can trust. Pure: no React Native or Expo
// imports, so the Node test runner can exercise it.

export type TitleCandidate = { title: string; author?: string };

// Release noise that never helps tell one book from another.
const NOISE = new Set([
  'audiobook', 'audiobooks', 'unabridged', 'abridged', 'retail',
  'mp3', 'm4b', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'kbps', 'read', 'narrated',
]);

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
function normalise(s: string): string {
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const words = (s: string) => normalise(s).split(' ').filter(Boolean);

/** Every word of `needle` appears as a whole word in `hay`; a name word is used at most once. */
function containsWords(hay: string[], needle: string[]): boolean {
  const pool = [...hay];
  for (const w of needle) {
    const i = pool.indexOf(w);
    if (i < 0) return false;
    pool.splice(i, 1);
  }
  return true;
}

/**
 * Picks the best candidate whose title appears as whole words in the torrent name, and whose author's
 * surname does too when one is given. Prefers the longest title. Returns undefined rather than guess:
 * a wrong title is worse than leaving the raw torrent name.
 */
export function matchTitle(torrentName: string, candidates: TitleCandidate[]): { title: string; author?: string } | undefined {
  const name = words(torrentName);
  const meaningful = name.filter((w) => !NOISE.has(w) && !/^\d+$/.test(w));
  let best: { title: string; author?: string } | undefined;
  let bestLen = -1;
  for (const c of candidates) {
    const title = words(c.title);
    if (!title.length || title.join('').length < 3) continue; // a two-letter title is too easy to misread
    if (!containsWords(name, title)) continue;
    const author = (c.author ?? '').trim();
    if (author) {
      const surname = words(author).pop();
      if (!surname || !containsWords(name, [surname])) continue;
    } else if (title.length < meaningful.length / 2) {
      continue; // no author to confirm it: the title has to account for most of the name
    }
    const len = title.join(' ').length;
    if (len > bestLen) { bestLen = len; best = author ? { title: c.title, author } : { title: c.title }; }
  }
  return best;
}
