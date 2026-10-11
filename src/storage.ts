import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSecret, setSecret, deleteSecret } from './secure';
import type { ScraperDef } from './scrapers/engine';
import type { CatalogBook } from './catalog';
import type { Downloads } from './downloads/state';
import type { EmbeddedChapter } from './chapters/embedded';
import type { ReadalongRecord } from './readalong/anchors';
import type { PendingJobs } from './readalong/pending';
import type { ReadElsewhere } from './reading-history';
import { emitLocalChange } from './sync/events';
import { sizeWeightedFraction } from './book-math';
import { parseStored } from './json-store';
import { mergeRemoteBuiltins } from './scrapers/merge';

const KEY = 'torbox_api_key';
export const getApiKey = () => getSecret(KEY);
export const setApiKey = (k: string) => setSecret(KEY, k);
export const clearApiKey = () => deleteSecret(KEY);

// Key for the AI service behind personal "Surprise me" picks (Gemini, Groq or Grok). Encrypted, like the TorBox key.
const AI_KEY = 'ai_api_key';
export const getAiKey = () => getSecret(AI_KEY);
export const setAiKey = (k: string | null) => (k ? setSecret(AI_KEY, k) : deleteSecret(AI_KEY));

// ---- GitHub gist sync token, kept in the same secure storage as the TorBox key ----
const GH_KEY = 'github_sync_token';
export const getGithubToken = () => getSecret(GH_KEY);
export const setGithubToken = (t: string) => setSecret(GH_KEY, t);
export const clearGithubToken = () => deleteSecret(GH_KEY);

// Keys whose stored value could not be read this session. App shows one toast about them; read-and-clear.
const corruptKeys: string[] = [];
export function takeCorruptKeys(): string[] {
  return corruptKeys.splice(0, corruptKeys.length);
}

async function getJSON<T>(key: string, fallback: T): Promise<T> {
  let raw: string | null;
  try { raw = await AsyncStorage.getItem(key); } catch { return fallback; }
  const { value, corrupt } = parseStored(raw, fallback);
  if (corrupt && raw) {
    if (!corruptKeys.includes(key)) corruptKeys.push(key);
    // Keep the unreadable text under a backup key, so the next write does not silently destroy it.
    try { await AsyncStorage.setItem(`corrupt:${key}`, raw); } catch { /* best effort */ }
  }
  return value;
}
const setJSON = (key: string, v: unknown) => AsyncStorage.setItem(key, JSON.stringify(v));

// ---- The gist Earmark found or created. Cached so the token alone is enough to reconnect. ----
export const loadGistId = () => getJSON<string | null>('sync_gist_id', null);
export const saveGistId = (id: string) => setJSON('sync_gist_id', id);
export const clearGistId = () => AsyncStorage.removeItem('sync_gist_id');

// ---- Sync stamps: when each non-progress record last changed locally, for last-write-wins. ----
// Progress carries its own `updated`; meta/hidden/wishlist/settings do not, so they are stamped here.
export type SyncStamps = {
  meta: Record<string, number>;
  hidden: Record<string, number>;
  wishlist: Record<string, number>;
  settings: number;
  readalong: Record<string, number>;
};
export async function loadStamps(): Promise<SyncStamps> {
  const s = await getJSON<Partial<SyncStamps>>('sync_stamps', {});
  return {
    meta: s.meta ?? {}, hidden: s.hidden ?? {}, wishlist: s.wishlist ?? {},
    settings: s.settings ?? 0, readalong: s.readalong ?? {},
  };
}
export const saveStamps = (s: SyncStamps) => setJSON('sync_stamps', s);

// ---- Listening progress, keyed by torrent id ----
export type Progress = {
  fileId: number;
  chapterIndex: number;
  chapterCount: number;
  position: number;
  duration: number;
  updated: number;
  finished?: boolean;
};
export const loadProgress = () => getJSON<Record<string, Progress>>('progress', {});
export async function saveProgress(torrentId: number, p: Progress) {
  const all = await loadProgress();
  all[String(torrentId)] = p;
  await setJSON('progress', all);
}
/** Writes progress that came from sync, exactly as received (its own `updated` is the stamp). */
export async function applyRemoteProgress(entries: { id: number; p: Progress }[]) {
  if (!entries.length) return;
  const all = await loadProgress();
  for (const { id, p } of entries) all[String(id)] = p;
  await setJSON('progress', all);
}
/** Deletes progress for the given torrent ids; used by a backup Replace. */
export async function removeProgress(ids: number[]) {
  if (!ids.length) return;
  const all = await loadProgress();
  for (const id of ids) delete all[String(id)];
  await setJSON('progress', all);
}

// ---- Offline downloads (device-local; deliberately absent from the sync document) ----
export const loadDownloads = () => getJSON<Downloads>('downloads', {});
export const saveDownloads = (d: Downloads) => setJSON('downloads', d);
/**
 * Overall book progress, 0..1. Pass the book's audio file sizes (chapterList(book)) to weight each
 * chapter by size; without them this falls back to treating every chapter as the same length.
 */
export const bookFraction = (p?: Progress, sizes?: number[]) =>
  !p ? 0 : sizeWeightedFraction(sizes, p.chapterIndex, p.position, p.duration, p.chapterCount, p.finished);

// ---- Embedded chapters found inside a single-file book (device-local; not synced, not in backups) ----
// Keyed by info-hash + file id so each file is probed once. A `chapters: null` entry is the "none
// found" marker: the file was read and had no usable chapters, so it need not be fetched again.
// The version lets a future parser change invalidate everything at once.
export const EMBEDDED_CACHE_VERSION = 1;
type EmbeddedCache = Record<string, { v: number; chapters: EmbeddedChapter[] | null }>;
const embeddedKey = (hash: string, fileId: number) => `${hash.toLowerCase()}:${fileId}`;
const loadEmbeddedCache = () => getJSON<EmbeddedCache>('embedded_chapters', {});
/** The cached chapters for a file, or undefined when it has never been probed. */
export async function loadEmbeddedChapters(hash: string, fileId: number): Promise<EmbeddedChapter[] | null | undefined> {
  const e = (await loadEmbeddedCache())[embeddedKey(hash, fileId)];
  return e && e.v === EMBEDDED_CACHE_VERSION ? e.chapters : undefined;
}
export async function saveEmbeddedChapters(hash: string, fileId: number, chapters: EmbeddedChapter[] | null) {
  const all = await loadEmbeddedCache();
  all[embeddedKey(hash, fileId)] = { v: EMBEDDED_CACHE_VERSION, chapters };
  await setJSON('embedded_chapters', all);
}

// ---- Book metadata (cover/author) remembered from search, keyed by info-hash ----
// coverChecked: when a cover lookup last found nothing (ms), so it isn't repeated on every refresh.
// finishedAt: ms epoch the book was marked finished; cleared when it is un-finished. rating: the
// user's own 0.5–5 half-star rating, or absent. Both ride the same meta stamp as the other fields.
export type BookMeta = { title?: string; author?: string; narrator?: string; cover?: string; coverChecked?: number; finishedAt?: number; rating?: number };
export const loadMeta = () => getJSON<Record<string, BookMeta>>('meta', {});
export const saveMeta = (hash: string, m: BookMeta) => saveMetaMany({ [hash]: m });

// `coverChecked` is device-local bookkeeping: a change to it alone is not a real edit.
const metaKey = (m: BookMeta) => { const { coverChecked, ...rest } = m; return JSON.stringify(rest, Object.keys(rest).sort()); };
const metaChanged = (before: BookMeta | undefined, after: BookMeta) => metaKey(before ?? {}) !== metaKey(after);

/** Merges several books' metadata in one write; returns the full updated map. */
export async function saveMetaMany(patch: Record<string, BookMeta>) {
  const all = await loadMeta();
  const stamps = await loadStamps();
  const now = Date.now();
  let changed = false;
  for (const [hash, m] of Object.entries(patch)) {
    const key = hash.toLowerCase();
    const before = all[key];
    const after = { ...before, ...m };
    all[key] = after;
    if (metaChanged(before, after)) { stamps.meta[key] = now; changed = true; }
  }
  await setJSON('meta', all);
  if (changed) { await saveStamps(stamps); emitLocalChange(); }
  return all;
}
/** Writes metadata from sync, stamped with the remote time and never re-stamped locally. */
export async function applyRemoteMeta(entries: { hash: string; value: BookMeta | null; updated: number }[]) {
  if (!entries.length) return;
  const all = await loadMeta();
  const stamps = await loadStamps();
  for (const e of entries) {
    const key = e.hash.toLowerCase();
    if (e.value === null) delete all[key];
    else {
      // Fields the other device has no value for keep the local one (a cover found here, say), except
      // the finish date and rating: those are cleared by hand, so the winning record decides them.
      const { finishedAt: _f, rating: _r, ...kept } = all[key] ?? {};
      all[key] = { ...kept, ...e.value };
    }
    stamps.meta[key] = e.updated;
  }
  await setJSON('meta', all);
  await saveStamps(stamps);
}

// ---- Books the user moved out of the main library (info-hashes). Local only; TorBox is untouched. ----
export const loadHiddenBooks = () => getJSON<string[]>('hidden_books', []);
const writeHidden = (hashes: string[]) => setJSON('hidden_books', hashes);
export async function saveHiddenBooks(hashes: string[]) {
  const before = new Set((await loadHiddenBooks()).map((h) => h.toLowerCase()));
  const after = [...new Set(hashes.map((h) => h.toLowerCase()))];
  const afterSet = new Set(after);
  if (before.size === afterSet.size && after.every((h) => before.has(h))) return;
  await writeHidden(after);
  const stamps = await loadStamps();
  const now = Date.now();
  for (const h of after) if (!before.has(h)) stamps.hidden[h] = now;
  for (const h of before) if (!afterSet.has(h)) stamps.hidden[h] = now; // removal -> tombstone stamp
  await saveStamps(stamps);
  emitLocalChange();
}
export async function applyRemoteHidden(entries: { hash: string; value: boolean; updated: number }[]) {
  if (!entries.length) return;
  const set = new Set((await loadHiddenBooks()).map((h) => h.toLowerCase()));
  for (const e of entries) { const h = e.hash.toLowerCase(); if (e.value) set.add(h); else set.delete(h); }
  await writeHidden([...set]);
  const stamps = await loadStamps();
  for (const e of entries) stamps.hidden[e.hash.toLowerCase()] = e.updated;
  await saveStamps(stamps);
}

// ---- "Want to listen": books saved from the catalogue search ----
export const loadWishlist = () => getJSON<CatalogBook[]>('wishlist', []);
const writeWishlist = (books: CatalogBook[]) => setJSON('wishlist', books);
export async function saveWishlist(books: CatalogBook[]) {
  const before = await loadWishlist();
  const beforeIds = new Set(before.map((b) => String(b.id)));
  const afterIds = new Set(books.map((b) => String(b.id)));
  if (beforeIds.size === afterIds.size && [...afterIds].every((id) => beforeIds.has(id))) return;
  await writeWishlist(books);
  const stamps = await loadStamps();
  const now = Date.now();
  for (const id of afterIds) if (!beforeIds.has(id)) stamps.wishlist[id] = now;
  for (const id of beforeIds) if (!afterIds.has(id)) stamps.wishlist[id] = now; // removal -> tombstone stamp
  await saveStamps(stamps);
  emitLocalChange();
}
export async function applyRemoteWishlist(entries: { id: string; value: CatalogBook | null; updated: number }[]) {
  if (!entries.length) return;
  const map = new Map((await loadWishlist()).map((b) => [String(b.id), b]));
  for (const e of entries) { if (e.value) map.set(e.id, e.value); else map.delete(e.id); }
  await writeWishlist([...map.values()]);
  const stamps = await loadStamps();
  for (const e of entries) stamps.wishlist[e.id] = e.updated;
  await saveStamps(stamps);
}

// ---- Read-along records (anchors from tools/readalong), keyed by info-hash ----
export const loadAllReadalong = () => getJSON<Record<string, ReadalongRecord>>('readalong', {});
/** The stored read-along record for one book, or null. */
export async function loadReadalong(hash: string): Promise<ReadalongRecord | null> {
  const all = await loadAllReadalong();
  return all[hash.toLowerCase()] ?? null;
}
/** Saves a record for one book, stamps it now and tells sync there is a local change. */
export async function saveReadalong(hash: string, record: ReadalongRecord) {
  const all = await loadAllReadalong();
  const stamps = await loadStamps();
  const key = hash.toLowerCase();
  all[key] = record;
  stamps.readalong[key] = Date.now();
  await setJSON('readalong', all);
  await saveStamps(stamps);
  emitLocalChange();
}
/** Deletes a book's record; the local stamp acts as a tombstone so the delete syncs. */
export async function deleteReadalong(hash: string) {
  const all = await loadAllReadalong();
  const stamps = await loadStamps();
  const key = hash.toLowerCase();
  delete all[key];
  stamps.readalong[key] = Date.now();
  await setJSON('readalong', all);
  await saveStamps(stamps);
  emitLocalChange();
}
/** Writes read-along records that came from sync, stamped with the remote time. */
export async function applyRemoteReadalong(entries: { hash: string; value: ReadalongRecord | null; updated: number }[]) {
  if (!entries.length) return;
  const all = await loadAllReadalong();
  const stamps = await loadStamps();
  for (const e of entries) {
    const key = e.hash.toLowerCase();
    if (e.value === null) delete all[key];
    else all[key] = e.value;
    stamps.readalong[key] = e.updated;
  }
  await setJSON('readalong', all);
  await saveStamps(stamps);
}

// ---- Read-along build server (the URL is plain storage; the token is a secret) ----
const READALONG_SERVER_TOKEN = 'readalong_server_token';
const READALONG_SERVER_URL = 'readalong_server_url';
export const loadReadalongServerUrl = () => getJSON<string>(READALONG_SERVER_URL, '');
export const saveReadalongServerUrl = (url: string) => setJSON(READALONG_SERVER_URL, url.trim());
export const getReadalongServerToken = () => getSecret(READALONG_SERVER_TOKEN);
export const setReadalongServerToken = (token: string) => setSecret(READALONG_SERVER_TOKEN, token.trim());
export async function clearReadalongServer() {
  await AsyncStorage.removeItem(READALONG_SERVER_URL);
  await deleteSecret(READALONG_SERVER_TOKEN);
}

// ---- Narrators the user follows (device-local; deliberately absent from the sync document) ----
// Stored as typed, compared through src/narrators' normaliser. Included in a backup, never a setup file.
export const loadFavNarrators = () => getJSON<string[]>('fav_narrators', []);
export const saveFavNarrators = (list: string[]) => setJSON('fav_narrators', list);

// ---- Books finished elsewhere (imported from Hardcover or a Goodreads export). Device-local: the sync
// document never carries them, but a full backup does and a setup file does not. `read_elsewhere_removed`
// remembers ids the user took off the shelf, so re-importing the same source does not bring them back.
export const loadReadElsewhere = () => getJSON<ReadElsewhere[]>('read_elsewhere', []);
export const saveReadElsewhere = (list: ReadElsewhere[]) => setJSON('read_elsewhere', list);
export const loadRemovedReadElsewhere = () => getJSON<string[]>('read_elsewhere_removed', []);
export const saveRemovedReadElsewhere = (ids: string[]) => setJSON('read_elsewhere_removed', ids);
/** Takes one entry off the shelf and remembers its id, so a later import does not restore it. */
export async function removeReadElsewhere(id: string) {
  const [list, removed] = await Promise.all([loadReadElsewhere(), loadRemovedReadElsewhere()]);
  await saveReadElsewhere(list.filter((e) => e.id !== id));
  if (!removed.includes(id)) await saveRemovedReadElsewhere([...removed, id]);
}

// ---- EPUB search address for the read-along builder (device-local; not in the sync document) ----
const EBOOK_SEARCH_URL_KEY = 'ebook_search_url';
export const loadEbookSearchUrl = () => getJSON<string>(EBOOK_SEARCH_URL_KEY, '');
export const saveEbookSearchUrl = (url: string) => setJSON(EBOOK_SEARCH_URL_KEY, url.trim());

// ---- Pending server builds, keyed by audiobook hash (device-local, not synced) ----
export const loadPendingJobs = () => getJSON<PendingJobs>('readalong_pending', {});
export const savePendingJobs = (pending: PendingJobs) => setJSON('readalong_pending', pending);

// ---- Update check (device-local; deliberately absent from the sync document) ----
export const loadUpdateCheckedAt = () => getJSON<number>('update_checked_at', 0);
export const saveUpdateCheckedAt = (t: number) => setJSON('update_checked_at', t);
export const loadDismissedUpdate = () => getJSON<string>('update_dismissed', '');
export const saveDismissedUpdate = (version: string) => setJSON('update_dismissed', version);

// ---- The version the app last ran (device-local; drives the one-time "what's new" sheet) ----
export const loadLastVersion = () => getJSON<string>('last_version', '');
export const saveLastVersion = (version: string) => setJSON('last_version', version);

// ---- Scrapers ----
export const loadUserScrapers = () => getJSON<ScraperDef[]>('scrapers', []);
export const saveUserScrapers = (s: ScraperDef[]) => setJSON('scrapers', s);
export const loadDisabled = () => getJSON<string[]>('scrapers_disabled', []);
export const saveDisabled = (ids: string[]) => setJSON('scrapers_disabled', ids);

/**
 * One-time migration from the old hosted-manifest built-ins: fold any definitions saved under
 * `scrapers_remote_builtin` into the user's own sources, then drop that key. Returns the user's
 * sources after the merge. After this they are ordinary sources that can be disabled or deleted.
 */
export async function migrateRemoteBuiltins(): Promise<ScraperDef[]> {
  const saved = await getJSON<ScraperDef[]>('scrapers_remote_builtin', []);
  const user = await loadUserScrapers();
  if (!saved.length) return user;
  const merged = mergeRemoteBuiltins(saved, user);
  await saveUserScrapers(merged);
  await AsyncStorage.removeItem('scrapers_remote_builtin');
  return merged;
}

// ---- Misc settings ----
export type Settings = { rate: number; skipBack: number; skipForward: number; lastBookId?: number };
const DEFAULT_SETTINGS: Settings = { rate: 1, skipBack: 15, skipForward: 30 };
export const loadSettings = async () => ({ ...DEFAULT_SETTINGS, ...(await getJSON<Partial<Settings>>('settings', {})) });
const sameSettings = (a: Settings, b: Settings) => a.rate === b.rate && a.skipBack === b.skipBack && a.skipForward === b.skipForward;
export async function saveSettings(patch: Partial<Settings>) {
  const before = await loadSettings();
  const after = { ...before, ...patch };
  await setJSON('settings', after);
  // lastBookId is device-local: only the synced playback settings count as a real change.
  if (!sameSettings(before, after)) {
    const stamps = await loadStamps();
    stamps.settings = Date.now();
    await saveStamps(stamps);
    emitLocalChange();
  }
}
export async function applyRemoteSettings(value: Pick<Settings, 'rate' | 'skipBack' | 'skipForward'> | null, updated: number) {
  if (value) {
    const current = await loadSettings();
    await setJSON('settings', { ...current, rate: value.rate, skipBack: value.skipBack, skipForward: value.skipForward });
  }
  const stamps = await loadStamps();
  stamps.settings = updated;
  await saveStamps(stamps);
}
