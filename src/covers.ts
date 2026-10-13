// Covers for library books: an automatic Open Library lookup for books that weren't added
// through Discover (and so have no remembered cover), plus the sources the cover picker searches.
// Docs: https://openlibrary.org/dev/docs/api/search · https://performance-partners.apple.com/search-api
import type { TBTorrent } from './torbox';
import { BookMeta, saveMetaMany } from './storage';
import { fetchWithTimeout } from './fetch-timeout';
import { prettyName } from './theme';
import { getHcToken, searchBooks } from './hardcover';
import { matchTitle } from './title-match';

const RETRY_MS = 7 * 24 * 3600 * 1000; // re-try books with no match after a week
const inFlight = new Set<string>(); // the library refreshes often; don't look the same book up twice at once

/** Turns a torrent name like "Andy Weir - Project Hail Mary (2021) [Ray Porter] 64kbps" into a search query. */
export function coverQuery(name: string) {
  return prettyName(name)
    .replace(/[\[({][^\])}]*[\])}]/g, ' ') // anything bracketed: years, narrators, formats
    .replace(/\b(unabridged|abridged|audiobook|audio ?book|m4b|mp3|aac|flac|\d+\s?kbps|retail|read by .*)\b/gi, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[-–—:|,]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function getJSON(url: string) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Earmark audiobook app' } }, 20_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const olCover = (id: number) => `https://covers.openlibrary.org/b/id/${id}-M.jpg`;

type OlDoc = { title?: string; author_name?: string[]; cover_i?: number };

async function lookup(query: string): Promise<OlDoc[]> {
  const json = await getJSON(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5&fields=cover_i,title,author_name`);
  return (json.docs as OlDoc[] | undefined) ?? [];
}

// ---- Cover picker: several sources searched side by side ----

export type CoverOption = { uri: string; label?: string };
export type CoverSource = { name: string; search: (query: string) => Promise<CoverOption[]> };

/** Audiobook editions on Apple Books: square art, usually the actual audiobook cover. */
const apple: CoverSource = {
  name: 'Apple Books audiobooks',
  async search(q) {
    const json = await getJSON(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=audiobook&limit=18`);
    return (json.results ?? [])
      .filter((r: any) => r.artworkUrl100)
      .map((r: any) => ({ uri: String(r.artworkUrl100).replace(/\/\d+x\d+bb\./, '/600x600bb.'), label: r.collectionName }));
  },
};

/** Open Library: every edition of the best match (English first), then covers of other matching works. */
const openLibrary: CoverSource = {
  name: 'Open Library',
  async search(q) {
    const json = await getJSON(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=8&fields=key,title,cover_i`);
    const docs: { key?: string; title?: string; cover_i?: number }[] = json.docs ?? [];
    let editions: CoverOption[] = [];
    if (docs[0]?.key) {
      try {
        const ed = await getJSON(`https://openlibrary.org${docs[0].key}/editions.json?limit=100`);
        const english = (e: any) => !e.languages || e.languages.some((l: any) => l.key === '/languages/eng');
        editions = (ed.entries ?? [])
          .filter((e: any) => e.covers?.[0] > 0)
          .sort((a: any, b: any) => Number(english(b)) - Number(english(a)))
          .slice(0, 24)
          .map((e: any) => ({ uri: olCover(e.covers[0]), label: e.title }));
      } catch { /* the work-level covers below still help */ }
    }
    const works = docs.filter((d) => d.cover_i).map((d) => ({ uri: olCover(d.cover_i!), label: d.title }));
    return [...editions, ...works];
  },
};

/** Hardcover, only when the user has connected it in Settings. */
const hardcover: CoverSource = {
  name: 'Hardcover',
  async search(q) {
    if (!(await getHcToken())) return [];
    return (await searchBooks(q)).filter((b) => b.image).map((b) => ({ uri: b.image!, label: b.title }));
  },
};

export const COVER_SOURCES = [apple, openLibrary, hardcover];

/**
 * Looks up covers — and, for a book with no remembered title, a matching title/author — a few at a
 * time. Results (including "no match") are saved so each book is only searched once; onFound is called
 * once with everything new. Existing title/author/cover values are never overwritten.
 */
export async function fillMissingCovers(
  books: TBTorrent[], meta: Record<string, BookMeta>, onFound: (found: Record<string, BookMeta>) => void,
) {
  const now = Date.now();
  const todo = books.filter((b) => {
    const m = b.hash ? meta[b.hash.toLowerCase()] : undefined;
    if (!b.hash || inFlight.has(b.hash.toLowerCase())) return false;
    // cover === '' means the user removed it in the picker: leave it alone.
    const wantsCover = m?.cover === undefined;
    const wantsTitle = !m?.title;
    return (wantsCover || wantsTitle) && !(m?.coverChecked && now - m.coverChecked < RETRY_MS);
  });
  if (!todo.length) return;
  todo.forEach((b) => inFlight.add(b.hash.toLowerCase()));

  const found: Record<string, BookMeta> = {};
  const queue = [...todo];
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const hash = b.hash.toLowerCase();
      const existing = meta[hash] ?? {};
      const q = coverQuery(existing.title ? `${existing.title} ${existing.author ?? ''}` : b.name);
      try {
        const docs = q ? await lookup(q) : [];
        const entry: BookMeta = {};
        if (existing.cover === undefined) {
          const coverId = docs.find((d) => d.cover_i)?.cover_i;
          if (coverId) entry.cover = olCover(coverId);
        }
        let titleFilled = false;
        if (!existing.title) {
          const match = matchTitle(b.name, docs.filter((d) => d.title).map((d) => ({ title: d.title!, author: d.author_name?.[0] })));
          if (match) {
            entry.title = match.title;
            titleFilled = true;
            if (!existing.author && match.author) entry.author = match.author;
          }
        }
        // A lookup that didn't fill everything it was asked for waits a week before trying again.
        if ((existing.cover === undefined && !entry.cover) || (!titleFilled && !existing.title)) entry.coverChecked = now;
        found[hash] = entry;
      } catch {
        // Network trouble: leave it unmarked so the next refresh tries again.
      }
    }
  }));
  try {
    if (Object.keys(found).length) onFound(await saveMetaMany(found));
  } finally {
    todo.forEach((b) => inFlight.delete(b.hash.toLowerCase()));
  }
}
