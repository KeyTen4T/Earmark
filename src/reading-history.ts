// Books the user finished elsewhere (Hardcover or a Goodreads export): the entries the Finished shelf
// shows beside library books, the strict match against a library book, and the pure decision that
// folds an import into the library and the shelf. Pure: no React Native or Expo imports, so the Node
// test runner can exercise it (test/reading-history.test.ts).
import { cleanBookTitle } from './ratings-match';
import { normalizeRating } from './shelf';

export type ReadSource = 'hardcover' | 'goodreads';

/** One book finished elsewhere. `id` is stable per source, e.g. `hc:123` or `gr:456`. */
export type ReadElsewhere = {
  id: string;
  source: ReadSource;
  title: string;
  author?: string;
  cover?: string;
  finishedAt?: number;
  rating?: number;
};

/** The fields an import needs from a library book; the caller fills these from meta and progress. */
export type LibraryBook = {
  hash: string;
  title: string;
  author?: string;
  finished: boolean;
  rating?: number;
  finishedAt?: number;
};

const normalise = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const titleKey = (s: string) => normalise(cleanBookTitle(s));

/** Author surnames, lowercased, from "A, B" / "A & B" / "A and B" / "A/B". */
function surnames(author?: string): string[] {
  return String(author ?? '')
    .split(/\s*(?:,|&|\band\b|\/)\s*/i)
    .map((a) => normalise(a).split(' ').filter(Boolean).pop() ?? '')
    .filter(Boolean);
}

/**
 * Whether an imported book is a library book: the cleaned titles are equal and, when both sides name
 * an author, they share a surname. A missing author on one side leaves the title to decide.
 */
export function sameLibraryBook(a: { title: string; author?: string }, b: { title: string; author?: string }): boolean {
  const ta = titleKey(a.title), tb = titleKey(b.title);
  if (!ta || ta !== tb) return false;
  const sa = surnames(a.author), sb = surnames(b.author);
  if (!sa.length || !sb.length) return true;
  const set = new Set(sa);
  return sb.some((s) => set.has(s));
}

/** A rating or finish date to write onto a finished library book, only where it is empty. */
export type ImportFill = { hash: string; rating?: number; finishedAt?: number };

export type ImportPlan = {
  found: number;
  matchedFinished: number;
  gainRating: number;
  gainDate: number;
  skippedUnfinished: number;
  added: number;
  updated: number;
  fills: ImportFill[];
  entries: ReadElsewhere[];
};

/**
 * Folds imported books into the library and the shelf. A book matching a finished library book has its
 * blank rating and/or finish date filled; one matching an unfinished library book is skipped; anything
 * else becomes (or stays) a "read elsewhere" entry. An id the user removed stays removed. Idempotent:
 * importing the same source twice changes nothing after the first time.
 */
export function planReadingImport(
  found: ReadElsewhere[], library: LibraryBook[], existing: ReadElsewhere[], removed: string[] = [],
): ImportPlan {
  const removedSet = new Set(removed);
  const matched = new Set<string>();
  const fills: ImportFill[] = [];
  let matchedFinished = 0, gainRating = 0, gainDate = 0, skippedUnfinished = 0;

  for (const f of found) {
    const book = library.find((b) => sameLibraryBook(f, b));
    if (!book) continue;
    matched.add(f.id);
    if (!book.finished) { skippedUnfinished++; continue; }
    matchedFinished++;
    const fill: ImportFill = { hash: book.hash };
    const rating = normalizeRating(f.rating);
    if (rating != null && book.rating == null) { fill.rating = rating; gainRating++; }
    if (f.finishedAt != null && book.finishedAt == null) { fill.finishedAt = f.finishedAt; gainDate++; }
    if (fill.rating != null || fill.finishedAt != null) fills.push(fill);
  }

  // An entry that now matches a library book, or that the user removed, no longer belongs on the shelf.
  const entries = existing.filter((e) => !removedSet.has(e.id) && !matched.has(e.id));
  const byId = new Map(entries.map((e) => [e.id, e]));
  let added = 0, updated = 0;
  for (const f of found) {
    if (matched.has(f.id) || removedSet.has(f.id)) continue;
    if (byId.has(f.id)) updated++; else added++;
    byId.set(f.id, f);
  }
  return { found: found.length, matchedFinished, gainRating, gainDate, skippedUnfinished, added, updated, fills, entries: [...byId.values()] };
}

// ---- Hardcover's "read" books ----

/** A `user_books` row as returned by hardcover.ts's history query. */
export type HcHistoryRow = {
  rating?: number | string | null;
  book?: {
    id?: number;
    title?: string | null;
    image?: { url?: string | null } | null;
    contributions?: { author?: { name?: string | null } | null }[] | null;
  } | null;
  user_book_reads?: { finished_at?: string | null }[] | null;
};

/** A Date from Hardcover's `YYYY-MM-DD` finish date, built from local parts so it lands on that day. */
export function parseFinishedDate(s?: string | null): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
  if (!m) return undefined;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(at) ? at : undefined;
}

/** Turns Hardcover history rows into entries; a row without a book id or title is dropped. */
export function mapHardcoverHistory(rows: unknown): ReadElsewhere[] {
  if (!Array.isArray(rows)) return [];
  const out: ReadElsewhere[] = [];
  for (const r of rows) {
    const row = (r ?? {}) as HcHistoryRow;
    const book = row.book ?? {};
    const bookId = book.id;
    const title = typeof book.title === 'string' ? book.title.trim() : '';
    if (bookId == null || !title) continue;
    const authors = (book.contributions ?? [])
      .map((c) => c?.author?.name)
      .filter((n): n is string => typeof n === 'string' && !!n.trim());
    let finishedAt: number | undefined;
    for (const read of row.user_book_reads ?? []) {
      const at = parseFinishedDate(read?.finished_at);
      if (at != null && (finishedAt == null || at > finishedAt)) finishedAt = at;
    }
    const rawRating = typeof row.rating === 'string' ? Number(row.rating) : row.rating;
    out.push({
      id: `hc:${bookId}`, source: 'hardcover', title,
      author: authors.length ? authors.join(', ') : undefined,
      cover: typeof book.image?.url === 'string' && book.image.url ? book.image.url : undefined,
      finishedAt,
      rating: normalizeRating(rawRating),
    });
  }
  return out;
}
