// Pure helpers for the ratings and reviews shown on a Discover book's detail page: cleaning an Apple
// catalogue title, deciding whether an Open Library or Hardcover result is the same book, choosing the
// best-rated match, formatting a count, and turning Hardcover review rows into plain text. No React
// Native or Expo imports, so the Node test runner can exercise it. Title and author matching reuses the
// library's existing matcher rather than growing a second one.
import { matchTitle } from './title-match';
import { decodeEntities } from './scrapers/template';

// Fewer than this many ratings and the average is too thin to show at all.
export const MIN_RATINGS = 3;
// How many reviews the detail page shows.
export const REVIEW_LIMIT = 5;

export type BookKey = { title: string; author?: string };

export type RatingCandidate = {
  key?: string; // the Open Library work key, e.g. /works/OL45804W
  title: string;
  author?: string;
  ratingsAverage?: number;
  ratingsCount?: number;
};

/**
 * Strips the parts of an Apple catalogue title that aren't the book's own name: a subtitle after ':' or
 * ' - ', an edition note like "(Unabridged)", and a series suffix such as ", Book 1" or "(The Expanse 1)".
 */
export function cleanBookTitle(raw: string): string {
  let t = String(raw ?? '');
  // Bracketed asides: (Unabridged), (The Expanse 1), [Dramatized].
  t = t.replace(/\s*[\[(][^\])}]*[\])}]/g, ' ');
  // Subtitle after a spaced colon or dash (hyphen, en dash or em dash).
  const cut = t.search(/\s*[:–—]\s+|\s+-\s+/);
  if (cut > 0) t = t.slice(0, cut);
  // Series suffix: ", Book 1", "Book 2 of the Dune Chronicles".
  t = t.replace(/[,]?\s+book\s+\d+\b.*$/i, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Whether an Open Library or Hardcover result is clearly the same book: the candidate's cleaned title
 * has to sit inside the cleaned title we searched with (or be equal), and the two have to share an
 * author surname. An author on only one side is not enough — without a surname we cannot tell.
 */
export function clearMatch(book: BookKey, candidate: BookKey): boolean {
  const author = (book.author ?? '').trim();
  const candidateAuthor = (candidate.author ?? '').trim();
  if (!author || !candidateAuthor) return false;
  const hay = `${cleanBookTitle(book.title)} ${author}`;
  return !!matchTitle(hay, [{ title: cleanBookTitle(candidate.title), author: candidateAuthor }]);
}

/** The first candidate that clearly matches, in the order the service returned them. */
export function findClearMatch<C extends BookKey>(book: BookKey, candidates: C[]): C | undefined {
  return candidates.find((c) => clearMatch(book, c));
}

/** Among the clear matches, the one with the most ratings (and enough of them to show). */
export function pickBestRating(
  book: BookKey, candidates: RatingCandidate[], min = MIN_RATINGS,
): RatingCandidate | undefined {
  let best: RatingCandidate | undefined;
  for (const c of candidates) {
    if (!clearMatch(book, c)) continue;
    const count = c.ratingsCount ?? 0;
    if (count < min) continue;
    if (!best || count > (best.ratingsCount ?? 0)) best = c;
  }
  return best;
}

/** The Open Library search URL: title+author, or the looser full-text fallback. */
export function olSearchUrl(title: string, author: string, fallback = false): string {
  const fields = 'limit=8&fields=key,title,author_name,ratings_average,ratings_count';
  const base = 'https://openlibrary.org/search.json?';
  if (fallback) return `${base}q=${encodeURIComponent([title, author].filter(Boolean).join(' '))}&${fields}`;
  return `${base}title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}&${fields}`;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
export { num as toNumber };

/** Reads the docs array of an Open Library search response, tolerating anything missing. */
export function parseOlDocs(json: unknown): RatingCandidate[] {
  const docs = (json as { docs?: unknown })?.docs;
  if (!Array.isArray(docs)) return [];
  const out: RatingCandidate[] = [];
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    const row = d as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title : '';
    if (!title) continue;
    const names = row.author_name;
    out.push({
      key: typeof row.key === 'string' ? row.key : undefined,
      title,
      author: Array.isArray(names) && typeof names[0] === 'string' ? names[0] : undefined,
      ratingsAverage: num(row.ratings_average),
      ratingsCount: num(row.ratings_count),
    });
  }
  return out;
}

/** "4.3" — the average shown to one decimal. */
export const formatAverage = (avg: number) => (Math.round((avg || 0) * 10) / 10).toFixed(1);

/** "1 rating", "448 ratings", or "12.4k ratings" once there are thousands. */
export function formatRatings(n: number): string {
  const count = Math.max(0, Math.round(n || 0));
  if (count >= 1000) {
    const k = count / 1000;
    return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k ratings`;
  }
  return `${count} rating${count === 1 ? '' : 's'}`;
}

export const ratingAccessibilityLabel = (average: number, count: number, source: string) =>
  `Rated ${formatAverage(average)} out of 5 from ${formatRatings(count)} on ${source}`;

// ---- Hardcover reviews ----

export type Review = { username: string; rating?: number; text: string; likes: number };

/** HTML tags, common entities and the light Markdown that review bodies tend to carry. */
export function plainText(raw: string): string {
  let s = String(raw ?? '');
  s = s.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // images
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // links keep their text
  s = s.replace(/`{1,3}([^`]*)`{1,3}/g, '$1'); // inline and fenced code
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2'); // bold
  s = s.replace(/(\*|_)(.*?)\1/g, '$2'); // italic
  s = s.replace(/~~(.*?)~~/g, '$1'); // strikethrough
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, ''); // headings
  s = s.replace(/^[ \t]{0,3}>\s?/gm, ''); // quotes
  s = s.replace(/^[ \t]{0,3}(?:[-*+]|\d+\.)[ \t]+/gm, ''); // bullets and numbered lists
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Turns the `user_books` rows of a Hardcover response into the reviews the page shows: a non-empty
 * username and body, no spoiler flag, most liked first, at most five. A row missing or renaming any
 * field is simply dropped rather than guessed at.
 */
export function parseReviews(data: unknown, limit = REVIEW_LIMIT): Review[] {
  const rows = (data as { user_books?: unknown })?.user_books;
  if (!Array.isArray(rows)) return [];
  const out: Review[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const user = row.user as Record<string, unknown> | undefined;
    const username = user && typeof user.username === 'string' ? user.username.trim() : '';
    if (!username) continue;
    if (row.review_has_spoilers === true) continue;
    const raw = [row.review, row.review_raw, row.review_markdown]
      .find((v) => typeof v === 'string' && v.trim());
    const text = typeof raw === 'string' ? plainText(raw) : '';
    if (!text) continue;
    const rating = num(row.rating);
    out.push({ username, rating: rating != null && rating > 0 ? rating : undefined, text, likes: num(row.likes_count) ?? 0 });
  }
  return out.sort((a, b) => b.likes - a.likes).slice(0, Math.max(0, limit));
}
