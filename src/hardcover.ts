// Hardcover (hardcover.app) reading tracker, via its GraphQL API.
// Docs: https://docs.hardcover.app/api/getting-started/
import { getSecret, setSecret, deleteSecret } from './secure';
import AsyncStorage from '@react-native-async-storage/async-storage';

const URL = 'https://api.hardcover.app/v1/graphql';
const KEY = 'hardcover_token';
export const STATUS = { WANT: 1, READING: 2, READ: 3, DNF: 5 } as const;
const AUDIOBOOK_FORMAT = 2;

let cachedToken: string | null | undefined;
export async function getHcToken() {
  if (cachedToken === undefined) cachedToken = await getSecret(KEY);
  return cachedToken;
}
export async function setHcToken(t: string | null) {
  const clean = t ? t.trim().replace(/^bearer\s+/i, '') : null;
  cachedToken = clean;
  if (clean) await setSecret(KEY, clean);
  else await deleteSecret(KEY);
}

export async function gql<T>(query: string, variables: Record<string, unknown> = {}, token?: string | null): Promise<T> {
  const t = token ?? (await getHcToken());
  if (!t) throw new Error('Hardcover is not connected');
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}`, 'user-agent': 'Earmark audiobook player (Android)' },
    body: JSON.stringify({ query, variables }),
  });
  let json: any;
  try { json = await res.json(); } catch { throw new Error(`Hardcover returned HTTP ${res.status}`); }
  if (res.status === 401 || res.status === 403) throw new Error('Hardcover rejected the token');
  if (json.errors?.length) throw new Error(json.errors[0].message ?? 'Hardcover error');
  if (res.status === 429) throw new Error('Hardcover rate limit reached; try again in a minute');
  return json.data as T;
}

const first = <T,>(v: T | T[] | null | undefined): T | undefined => (Array.isArray(v) ? v[0] : v ?? undefined);

export type HcUser = { id: number; username: string };
export async function fetchMe(token?: string): Promise<HcUser> {
  const d = await gql<{ me: HcUser | HcUser[] }>('query { me { id username } }', {}, token);
  const me = first(d.me);
  if (!me) throw new Error('Hardcover did not return a user');
  await AsyncStorage.setItem('hc_user', JSON.stringify(me));
  return me;
}
export async function cachedMe(): Promise<HcUser | null> {
  const raw = await AsyncStorage.getItem('hc_user');
  if (raw) return JSON.parse(raw);
  try { return await fetchMe(); } catch { return null; }
}

export type HcBook = { id: number; title: string; authors: string[]; image?: string; year?: number; slug?: string; hasAudio?: boolean };
export async function searchBooks(q: string): Promise<HcBook[]> {
  const d = await gql<{ search: { error?: string; results: any } }>(
    'query Search($q: String!) { search(query: $q, query_type: "Book", per_page: 15) { error results } }', { q });
  if (d.search.error) throw new Error(d.search.error);
  const results = typeof d.search.results === 'string' ? JSON.parse(d.search.results) : d.search.results;
  return (results?.hits ?? []).map((h: any) => {
    const doc = h.document ?? {};
    return {
      id: Number(doc.id),
      title: doc.title ?? 'Untitled',
      authors: doc.author_names ?? [],
      image: doc.image?.url ?? undefined,
      year: doc.release_year ?? undefined,
      slug: doc.slug,
      hasAudio: doc.has_audiobook ?? (doc.audio_seconds ?? 0) > 0,
    } as HcBook;
  }).filter((b: HcBook) => b.id);
}

// ---- Link between a TorBox torrent and a Hardcover book ----
export type HcLink = {
  bookId: number;
  title: string;
  authors: string[];
  image?: string;
  slug?: string;
  editionId?: number;
  audioSeconds?: number;
  userBookId: number;
  readId?: number;
  lastSyncedSeconds?: number;
  lastSyncedAt?: number;
  finished?: boolean;
};
async function loadLinks(): Promise<Record<string, HcLink>> {
  const raw = await AsyncStorage.getItem('hc_links');
  return raw ? JSON.parse(raw) : {};
}
export async function getLink(torrentId: number) { return (await loadLinks())[String(torrentId)]; }
async function putLink(torrentId: number, l: HcLink | null) {
  const all = await loadLinks();
  if (l) all[String(torrentId)] = l; else delete all[String(torrentId)];
  await AsyncStorage.setItem('hc_links', JSON.stringify(all));
}
export const unlink = (torrentId: number) => putLink(torrentId, null);

/** All torrent <-> Hardcover links, for a backup. Not secret: contains no token. */
export const loadHcLinks = (): Promise<Record<string, HcLink>> => loadLinks();
export const saveHcLinks = (all: Record<string, HcLink>) => AsyncStorage.setItem('hc_links', JSON.stringify(all));

const today = () => new Date().toISOString().slice(0, 10);

/** Links a torrent to a Hardcover book, marks it Currently Reading and opens a read session. */
export async function linkBook(torrentId: number, book: HcBook): Promise<HcLink> {
  const me = await cachedMe();
  if (!me) throw new Error('Could not load your Hardcover account');

  // Prefer the audiobook edition so Hardcover shows time-based progress. Optional: linking works without it.
  let edition: { id: number; audio_seconds: number | null } | undefined;
  try {
    const ed = await gql<{ editions: { id: number; audio_seconds: number | null }[] }>(
      `query Ed($b: Int!, $f: Int!) { editions(where: { book_id: { _eq: $b }, reading_format_id: { _eq: $f } }, limit: 1) { id audio_seconds } }`,
      { b: book.id, f: AUDIOBOOK_FORMAT });
    edition = ed.editions?.[0];
  } catch { edition = undefined; }

  const existing = await gql<{ user_books: { id: number; status_id: number; edition_id: number | null }[] }>(
    `query UB($b: Int!, $u: Int!) { user_books(where: { book_id: { _eq: $b }, user_id: { _eq: $u } }, limit: 1) { id status_id edition_id } }`,
    { b: book.id, u: me.id });

  let userBookId: number;
  const ub = existing.user_books?.[0];
  if (ub) {
    userBookId = ub.id;
    if (ub.status_id !== STATUS.READING) {
      await gql(`mutation S($id: Int!, $s: Int!) { update_user_book(id: $id, object: { status_id: $s }) { id error } }`, { id: ub.id, s: STATUS.READING });
    }
  } else {
    const object: Record<string, unknown> = { book_id: book.id, status_id: STATUS.READING };
    if (edition) object.edition_id = edition.id;
    const ins = await gql<{ insert_user_book: { id: number; error?: string } }>(
      `mutation I($o: UserBookCreateInput!) { insert_user_book(object: $o) { id error } }`, { o: object });
    if (ins.insert_user_book.error) throw new Error(ins.insert_user_book.error);
    userBookId = ins.insert_user_book.id;
  }

  const reads = await gql<{ user_book_reads: { id: number; progress_seconds: number | null }[] }>(
    `query R($ub: Int!) { user_book_reads(where: { user_book_id: { _eq: $ub }, finished_at: { _is_null: true } }, order_by: { id: desc }, limit: 1) { id progress_seconds } }`,
    { ub: userBookId });

  const link: HcLink = {
    bookId: book.id, title: book.title, authors: book.authors, image: book.image, slug: book.slug,
    editionId: edition?.id, audioSeconds: edition?.audio_seconds ?? undefined,
    userBookId, readId: reads.user_book_reads?.[0]?.id,
  };
  await putLink(torrentId, link);
  return link;
}

import { listenedSeconds } from './hardcover-math';
export { listenedSeconds };

const inflight = new Set<number>();

// ---- Last sync failure, so the player can show it. Cleared on the next successful sync. ----
export type HcSyncError = { message: string; at: number };
let syncError: HcSyncError | null = null;
const syncErrorListeners = new Set<(e: HcSyncError | null) => void>();
const notifySyncError = () => { for (const l of syncErrorListeners) l(syncError); };
export const getHcSyncError = (): HcSyncError | null => syncError;
export function subscribeHcSyncError(fn: (e: HcSyncError | null) => void): () => void {
  syncErrorListeners.add(fn);
  fn(syncError);
  return () => { syncErrorListeners.delete(fn); };
}
function setSyncError(message: string | null) {
  if (!message && !syncError) return;
  syncError = message ? { message, at: Date.now() } : null;
  notifySyncError();
}

/** Pushes progress to Hardcover. Throttled per book; pass force on pause/finish. */
export type Spot = { sizes: number[]; index: number; position: number; duration: number };
export async function syncProgress(torrentId: number, spot: Spot, finished: boolean, force = false) {
  if (!(await getHcToken()) || inflight.has(torrentId)) return;
  const link = await getLink(torrentId);
  if (!link || (link.finished && finished)) return;
  const seconds = finished && link.audioSeconds
    ? link.audioSeconds
    : listenedSeconds(spot.sizes, spot.index, spot.position, spot.duration, link.audioSeconds);
  const now = Date.now();
  if (!force && !finished && link.lastSyncedAt && now - link.lastSyncedAt < 120_000) return;
  if (!finished && link.lastSyncedSeconds !== undefined && Math.abs(seconds - link.lastSyncedSeconds) < 30) return;

  inflight.add(torrentId);
  try {
    const read: Record<string, unknown> = { progress_seconds: Math.max(0, Math.round(seconds)) };
    if (link.editionId) read.edition_id = link.editionId;
    if (finished) read.finished_at = today();

    if (link.readId) {
      const r = await gql<{ update_user_book_read: { id: number; error?: string } }>(
        `mutation U($id: Int!, $o: DatesReadInput!) { update_user_book_read(id: $id, object: $o) { id error } }`, { id: link.readId, o: read });
      if (r.update_user_book_read?.error) throw new Error(r.update_user_book_read.error);
    } else {
      read.started_at = today();
      const r = await gql<{ insert_user_book_read: { id: number; error?: string } }>(
        `mutation N($ub: Int!, $o: DatesReadInput!) { insert_user_book_read(user_book_id: $ub, user_book_read: $o) { id error } }`, { ub: link.userBookId, o: read });
      if (r.insert_user_book_read?.error) throw new Error(r.insert_user_book_read.error);
      link.readId = r.insert_user_book_read.id;
    }
    if (finished) {
      await gql(`mutation S($id: Int!, $s: Int!) { update_user_book(id: $id, object: { status_id: $s }) { id error } }`, { id: link.userBookId, s: STATUS.READ });
      link.finished = true;
    }
    link.lastSyncedAt = now;
    link.lastSyncedSeconds = seconds;
    await putLink(torrentId, link);
    setSyncError(null);
  } catch (e: any) {
    console.warn('Hardcover sync failed', e);
    setSyncError(e?.message ?? 'Hardcover sync failed');
  } finally {
    inflight.delete(torrentId);
  }
}

/**
 * Pushes the user's own rating (0.5–5 half steps, or null to clear) to a linked book's `user_book`.
 * Unlinked books are local-only. Failures are reported like a progress sync and never block the
 * local rating. Note: this mutation is written from Hardcover's published schema and has not been run
 * against the API by the author.
 */
export async function syncRating(torrentId: number, rating: number | null) {
  if (!(await getHcToken())) return;
  const link = await getLink(torrentId);
  if (!link) return;
  try {
    const r = await gql<{ update_user_book: { id: number; error?: string } }>(
      `mutation R($id: Int!, $r: numeric) { update_user_book(id: $id, object: { rating: $r }) { id error } }`,
      { id: link.userBookId, r: rating });
    if (r.update_user_book?.error) throw new Error(r.update_user_book.error);
    setSyncError(null);
  } catch (e: any) {
    console.warn('Hardcover rating sync failed', e);
    setSyncError(e?.message ?? 'Hardcover rating sync failed');
  }
}
