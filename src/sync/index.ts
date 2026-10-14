// Cross-device sync through one private GitHub gist. This module is the coordinator: it translates
// between the local storage shape and the sync document, runs merge cycles one at a time, and owns
// the debounce/coalescing. Network trouble is swallowed (the last error is surfaced in Settings) so
// it can never interrupt playback.
import {
  emptyDoc, parseDoc, mergeDocs, docEquals, isTooNew, stableStringify,
  type SyncDoc, type ProgressRecord, type CatalogBook,
} from './merge';
import { findGist, createGist, readGist, writeGist, verifyToken, GistMissing } from './github';
import { emitSyncApplied, onLocalChange, onSyncApplied } from './events';
import { replaceDoc } from '../backup';
import type { TBTorrent } from '../torbox';
import {
  loadProgress, applyRemoteProgress, removeProgress, loadMeta, applyRemoteMeta,
  loadHiddenBooks, applyRemoteHidden, loadWishlist, applyRemoteWishlist,
  loadSettings, applyRemoteSettings, loadEbookSearchUrl, applyRemoteEbookSearch,
  loadStamps, loadAllReadalong, applyRemoteReadalong,
  loadListeningLog, applyRemoteListening, loadListeningEstimate, applyRemoteListeningEstimate,
  loadGistId, saveGistId, clearGistId, getGithubToken, setGithubToken, clearGithubToken,
} from '../storage';

export { onSyncApplied };

export type SyncStatus = {
  connected: boolean;
  busy: boolean;
  lastSyncAt: number;
  error: string;
  versionTooNew: boolean;
};

let status: SyncStatus = { connected: false, busy: false, lastSyncAt: 0, error: '', versionTooNew: false };
const statusListeners = new Set<(s: SyncStatus) => void>();
const notifyStatus = () => { for (const l of statusListeners) l(status); };
const setStatus = (patch: Partial<SyncStatus>) => { status = { ...status, ...patch }; notifyStatus(); };

export const getSyncStatus = (): SyncStatus => status;
/**
 * The GitHub token sync is using, or null. Callers must send it as a header and never log it or put
 * it in a URL. Used by the one-time estimate, which reads the gist's revision history.
 */
export const getSyncToken = (): string | null => token;
export function subscribeSyncStatus(fn: (s: SyncStatus) => void): () => void {
  statusListeners.add(fn);
  fn(status);
  return () => { statusListeners.delete(fn); };
}

// ---- Module state ----
let token: string | null = null;
let idToHash = new Map<number, string>();
let hashToId = new Map<string, number>();
let running = false;
let queued = false;
let lastAttempt = 0;
let debounce: ReturnType<typeof setTimeout> | null = null;
let initPromise: Promise<void> | null = null;

/** Reads the stored token and starts listening for local edits. Safe to call repeatedly. */
export function initSync(): Promise<void> {
  return (initPromise ??= (async () => {
    onLocalChange(() => scheduleSync());
    token = await getGithubToken();
    setStatus({ connected: !!token });
  })());
}

/** The library (torrent id <-> info-hash) is how local progress is translated to the gist. */
export function setSyncLibrary(books: TBTorrent[]): void {
  const idTo = new Map<number, string>();
  const hashTo = new Map<string, number>();
  for (const b of books) {
    if (!b.hash) continue;
    const h = b.hash.toLowerCase();
    idTo.set(b.id, h);
    hashTo.set(h, b.id);
  }
  idToHash = idTo;
  hashToId = hashTo;
}

/** Debounced sync after the user edits meta / hidden / wishlist / settings (~5s). */
export function scheduleSync(): void {
  if (!token) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => { debounce = null; void syncNow(); }, 5000);
}

/** Progress save trigger: immediate on pause/stop/chapter/finish, otherwise at most every 60s. */
export function syncAfterProgress(force: boolean): void {
  if (!token) return;
  if (force || Date.now() - lastAttempt > 60_000) void syncNow();
}

/** Runs one full cycle. Serialised: a request arriving mid-cycle is coalesced into one more run. */
export async function syncNow(opts: { timeoutMs?: number } = {}): Promise<void> {
  if (!initPromise) void initSync();
  if (initPromise) await initPromise;
  if (!token) return;
  if (running) { queued = true; return; }
  running = true;
  lastAttempt = Date.now();
  setStatus({ busy: true });
  try {
    const result = await runCycle(opts.timeoutMs);
    if (result.tooNew) setStatus({ error: 'This sync was written by a newer version of Earmark. Update the app.', versionTooNew: true });
    else {
      setStatus({ error: '', versionTooNew: false, lastSyncAt: Date.now() });
      if (result.changed) emitSyncApplied();
    }
  } catch (e: any) {
    setStatus({ error: e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'Sync timed out' : (e?.message ?? 'Sync failed') });
  } finally {
    running = false;
    setStatus({ busy: false });
    if (queued) { queued = false; void syncNow(); }
  }
}

export async function connectSync(raw: string): Promise<void> {
  const t = raw.trim();
  if (!t) throw new Error('Enter a GitHub token');
  await verifyToken(t);
  const local = await buildLocalDoc();
  const id = (await findGist(t)) ?? (await createGist(t, JSON.stringify(local)));
  await setGithubToken(t);
  await saveGistId(id);
  token = t;
  setStatus({ connected: true, error: '', versionTooNew: false });
  await syncNow();
}

export async function disconnectSync(): Promise<void> {
  token = null;
  await clearGithubToken();
  await clearGistId();
  setStatus({ connected: false, error: '', versionTooNew: false, lastSyncAt: 0 });
}

// ---- One cycle: read, merge, apply, write only if the merged doc differs from remote ----
async function runCycle(timeoutMs?: number): Promise<{ tooNew: boolean; changed: boolean }> {
  const t = token;
  if (!t) return { tooNew: false, changed: false };
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const signal = controller.signal;
  try {
    const local = await buildLocalDoc();
    let id = await loadGistId();
    if (!id) { id = (await findGist(t, signal)) ?? (await createGist(t, JSON.stringify(local), signal)); await saveGistId(id); }

    let remote: SyncDoc;
    try {
      remote = await readDoc(t, id, signal);
    } catch (e) {
      if (!(e instanceof GistMissing)) throw e;
      id = (await findGist(t, signal)) ?? (await createGist(t, JSON.stringify(local), signal)); // cached id went stale
      await saveGistId(id);
      remote = await readDoc(t, id, signal);
    }

    if (isTooNew(remote)) return { tooNew: true, changed: false }; // never write over a document from a newer app version

    const merged = mergeDocs(local, remote);
    const changed = await applyMerged(merged, local);
    if (!docEquals(merged, remote)) await writeGist(t, id, JSON.stringify(merged), signal);
    return { tooNew: false, changed };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readDoc(t: string, id: string, signal: AbortSignal): Promise<SyncDoc> {
  const content = await readGist(t, id, signal);
  if (!content) return emptyDoc();
  try { return parseDoc(JSON.parse(content)); }
  catch { throw new Error('The sync gist is not valid JSON'); }
}

const stampAt = (s: number | undefined) => Math.max(s ?? 0, 1); // pre-existing data: any real edit beats it

/** Local storage -> sync document. Progress is keyed by info-hash via the library list. */
export async function buildLocalDoc(): Promise<SyncDoc> {
  const [progress, meta, hidden, wishlist, settings, ebookUrl, stamps, readalong, listening, estimate] = await Promise.all([
    loadProgress(), loadMeta(), loadHiddenBooks(), loadWishlist(), loadSettings(), loadEbookSearchUrl(), loadStamps(), loadAllReadalong(), loadListeningLog(), loadListeningEstimate(),
  ]);
  const doc = emptyDoc();

  // Skip progress for torrents not in the library; those never leave the gist from this device.
  for (const [id, p] of Object.entries(progress)) {
    const hash = idToHash.get(Number(id));
    if (hash) doc.progress[hash] = p;
  }
  for (const [hash, m] of Object.entries(meta)) {
    const key = hash.toLowerCase();
    const { coverChecked, ...fields } = m;
    if (!Object.keys(fields).length) continue; // coverChecked alone is device-local bookkeeping, not synced
    doc.meta[key] = { value: fields, updated: stampAt(stamps.meta[key]) };
  }
  for (const [hash, updated] of Object.entries(stamps.meta)) if (!(hash in doc.meta)) doc.meta[hash] = { value: null, updated: stampAt(updated) };

  const hiddenSet = new Set(hidden.map((h) => h.toLowerCase()));
  for (const hash of hiddenSet) doc.hidden[hash] = { value: true, updated: stampAt(stamps.hidden[hash]) };
  for (const [hash, updated] of Object.entries(stamps.hidden)) if (!hiddenSet.has(hash)) doc.hidden[hash] = { value: false, updated: stampAt(updated) };

  const wishIds = new Set(wishlist.map((b) => String(b.id)));
  for (const b of wishlist) doc.wishlist[String(b.id)] = { value: b as unknown as CatalogBook, updated: stampAt(stamps.wishlist[String(b.id)]) };
  for (const id of Object.keys(stamps.wishlist)) if (!wishIds.has(id)) doc.wishlist[id] = { value: null, updated: stampAt(stamps.wishlist[id]) };

  doc.settings = { value: { rate: settings.rate, skipBack: settings.skipBack, skipForward: settings.skipForward }, updated: stampAt(stamps.settings) };

  // A device that never set the address carries stamp 0, so any synced value (which is stamped when
  // it changes) wins the merge. A deliberate clear is `''` with a fresh stamp and wins in turn.
  // An address typed in before this was synced has no stamp: it counts as an edit (1) so it reaches a
  // device that never had one (0), while any stamped change still beats it.
  doc.ebookSearch = { value: ebookUrl, updated: stamps.ebookSearch || (ebookUrl ? 1 : 0) };

  for (const [hash, rec] of Object.entries(readalong)) doc.readalong[hash.toLowerCase()] = { value: rec, updated: stampAt(stamps.readalong[hash.toLowerCase()]) };
  for (const [hash, updated] of Object.entries(stamps.readalong)) if (!(hash in doc.readalong)) doc.readalong[hash] = { value: null, updated: stampAt(updated) };

  doc.listening = listening;
  doc.listeningEstimate = estimate;

  return doc;
}

/** Writes the parts of the merged document that the remote side won. Returns true if anything changed. */
async function applyMerged(merged: SyncDoc, local: SyncDoc): Promise<boolean> {
  let changed = false;
  const progressEntries: { id: number; p: ProgressRecord }[] = [];
  for (const [hash, p] of Object.entries(merged.progress)) {
    const id = hashToId.get(hash);
    if (id === undefined) continue; // remote-only record: keep it in the gist, not on this device
    if (same(local.progress[hash], p)) continue;
    progressEntries.push({ id, p });
  }
  if (progressEntries.length) { await applyRemoteProgress(progressEntries); changed = true; }

  const meta = diffMap(merged.meta, local.meta, (hash, e) => ({ hash, value: e.value, updated: e.updated }));
  if (meta.length) { await applyRemoteMeta(meta); changed = true; }

  const hidden = diffMap(merged.hidden, local.hidden, (hash, e) => ({ hash, value: e.value === true, updated: e.updated }));
  if (hidden.length) { await applyRemoteHidden(hidden); changed = true; }

  const wishlist = diffMap(merged.wishlist, local.wishlist, (id, e) => ({ id, value: e.value, updated: e.updated }));
  if (wishlist.length) { await applyRemoteWishlist(wishlist); changed = true; }

  const readalong = diffMap(merged.readalong, local.readalong, (hash, e) => ({ hash, value: e.value, updated: e.updated }));
  if (readalong.length) { await applyRemoteReadalong(readalong); changed = true; }

  if (!same(local.settings, merged.settings)) { await applyRemoteSettings(merged.settings.value, merged.settings.updated); changed = true; }
  if (!same(local.ebookSearch, merged.ebookSearch)) { await applyRemoteEbookSearch(merged.ebookSearch.value, merged.ebookSearch.updated); changed = true; }
  if (!same(local.listening, merged.listening)) { await applyRemoteListening(merged.listening); changed = true; }
  if (!same(local.listeningEstimate, merged.listeningEstimate)) { await applyRemoteListeningEstimate(merged.listeningEstimate); changed = true; }
  return changed;
}

function same(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function diffMap<T, U>(merged: Record<string, T>, local: Record<string, T>, toEntry: (key: string, entry: T) => U): U[] {
  const out: U[] = [];
  for (const key of Object.keys(merged)) {
    if (key in local && same(local[key], merged[key])) continue;
    out.push(toEntry(key, merged[key]));
  }
  return out;
}

/**
 * Writes a backup's sync document into local storage. Merge loses to newer local records; Replace
 * re-stamps every restored record and tombstones every device record the file lacked, so the next
 * sync pushes the restored state instead of the gist overwriting it.
 */
export async function applyBackupSync(doc: SyncDoc, mode: 'merge' | 'replace'): Promise<void> {
  const local = await buildLocalDoc();
  const next = mode === 'replace' ? replaceDoc(local, doc, Date.now()) : mergeDocs(local, doc);
  const changed = await applyMerged(next, local);
  if (mode === 'replace') {
    // Progress carries no tombstone in the sync format, so device-only progress is deleted here.
    const gone = Object.keys(local.progress)
      .filter((hash) => !(hash in doc.progress))
      .map((hash) => hashToId.get(hash))
      .filter((id): id is number => id !== undefined);
    if (gone.length) { await removeProgress(gone); }
  }
  if (changed || mode === 'replace') emitSyncApplied();
}
