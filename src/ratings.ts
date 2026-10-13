// Ratings and reviews for a Discover book's detail page, from services that are free to reach:
// Open Library for an average and count (no key needed), and Hardcover for reviews (only when the user
// has connected it in Settings). The deciding, cleaning and formatting are pure and live in
// ratings-match.ts; this module only does the network calls and the per-session cache.
// Docs: https://openlibrary.org/dev/docs/api/search · https://docs.hardcover.app/api/
import { getHcToken, searchBooks, gql } from './hardcover';
import { fetchWithTimeout } from './fetch-timeout';
import {
  BookKey, RatingCandidate, Review,
  cleanBookTitle, findClearMatch, olSearchUrl, parseOlDocs, parseReviews, pickBestRating, toNumber,
} from './ratings-match';

const OL = 'https://openlibrary.org';
export type RatingSource = 'Open Library' | 'Hardcover';
export type Rating = { average: number; count: number; source: RatingSource; url?: string };
export type BookInfo = { rating?: Rating; reviews?: Review[]; slug?: string };

// Per-session cache keyed by the catalogue id, so reopening a book doesn't look it up again. A book
// with nothing found is cached too, as an empty result.
const cache = new Map<string, BookInfo>();

async function getJSON(url: string, fetcher: typeof fetch) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Earmark audiobook app' } }, 20_000, fetcher);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The Open Library average and count for a book, or null when nothing clearly matches. */
export async function openLibraryRating(book: BookKey, fetcher: typeof fetch = fetch): Promise<Rating | null> {
  const title = cleanBookTitle(book.title);
  const author = (book.author ?? '').trim();
  if (!title) return null;
  let best: RatingCandidate | undefined;
  try {
    best = pickBestRating({ title, author }, parseOlDocs(await getJSON(olSearchUrl(title, author), fetcher)));
    // If the title+author query found nothing, one looser full-text search.
    if (!best) best = pickBestRating({ title, author }, parseOlDocs(await getJSON(olSearchUrl(title, author, true), fetcher)));
  } catch {
    return null; // network trouble or a bad response: show nothing
  }
  if (!best?.key || best.ratingsAverage == null || best.ratingsCount == null) return null;
  return { average: best.ratingsAverage, count: best.ratingsCount, source: 'Open Library', url: `${OL}${best.key}` };
}

// A matched book's own aggregate plus the reviews its readers left. `review`/`review_raw`/`review_markdown`
// are all requested because old and new rows fill them differently; the parser takes whichever is present.
const HC_QUERY = `query BookReviews($id: Int!) {
  books(where: { id: { _eq: $id } }, limit: 1) { id slug rating ratings_count reviews_count }
  user_books(
    where: { book_id: { _eq: $id }, has_review: { _eq: true }, review_has_spoilers: { _eq: false } }
    order_by: { likes_count: desc }
    limit: 5
  ) {
    review
    review_raw
    review_markdown
    rating
    likes_count
    review_has_spoilers
    reviewed_at
    updated_at
    user { username }
  }
}`;

type HcBookRow = { id?: number; slug?: string | null; rating?: number | string | null; ratings_count?: number | null; reviews_count?: number | null };
type HcData = { books?: HcBookRow[]; user_books?: unknown[] };

/** Hardcover's rating and up to five reviews for a book, or null when not connected or no clear match. */
export async function hardcoverInfo(book: BookKey): Promise<BookInfo | null> {
  if (!(await getHcToken())) return null; // nothing is fetched without a token
  const q = [cleanBookTitle(book.title), book.author].filter((s) => s && String(s).trim()).join(' ');
  if (!q) return null;
  const found = await searchBooks(q);
  const match = findClearMatch(book, found.map((b) => ({ id: b.id, title: b.title, author: b.authors?.[0], slug: b.slug })));
  if (!match) return null;
  const data = await gql<HcData>(HC_QUERY, { id: match.id });
  const row = Array.isArray(data?.books) ? data.books[0] : undefined;
  const average = toNumber(row?.rating);
  const count = toNumber(row?.ratings_count);
  const rating: Rating | undefined = average != null && count != null && count > 0
    ? { average, count, source: 'Hardcover' } : undefined;
  const reviews = parseReviews(data);
  return { rating, reviews: reviews.length ? reviews : undefined, slug: (typeof row?.slug === 'string' ? row.slug : undefined) ?? match.slug };
}

/** Everything the detail page shows for a book, looked up once and cached for the session. */
export async function loadBookInfo(book: BookKey & { id: string | number }, fetcher: typeof fetch = fetch): Promise<BookInfo> {
  const id = String(book.id);
  const hit = cache.get(id);
  if (hit) return hit;
  const [ol, hc] = await Promise.all([
    openLibraryRating(book, fetcher).catch(() => null),
    hardcoverInfo(book).catch(() => null),
  ]);
  let rating = ol ?? hc?.rating;
  // Attribute a Hardcover average to its book page so the row's source is still a link.
  if (rating?.source === 'Hardcover' && hc?.slug) rating = { ...rating, url: `https://hardcover.app/books/${hc.slug}` };
  const info: BookInfo = { rating, reviews: hc?.reviews, slug: hc?.slug };
  cache.set(id, info);
  return info;
}
