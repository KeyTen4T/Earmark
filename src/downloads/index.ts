// The file-system/network half of offline downloads. Screens talk to this through the small
// subscribe/getState API and the action functions; all queue and per-file decisions live in the pure
// ./state.ts. Android only: every entry point returns early on the web/desktop build, where
// expo-file-system is not supported, so nothing here touches the file system there.
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import type { DownloadTask } from 'expo-file-system';
import { chapterList, getStreamUrl, type TBTorrent } from '../torbox';
import { loadDownloads, saveDownloads } from '../storage';
import { formatBytes } from '../scrapers/template';
import {
  activeBook, backoffMs, beginFile, bookKey, createBook, currentFile, enoughSpace, failFile, fileExt, get,
  isComplete, markForRedownload, nextQueued, pause, recordBytes, reconcileAfterRestart,
  remainingBytes, remove, resume, setBookStatus, settleFile, start, totalBytes, upsert, verifyFiles,
  DISK_MARGIN_BYTES, type DownloadBook, type Downloads,
} from './state';

const BOOKS_DIR = 'books';

let token = '';
let state: Downloads = {};
let ready = false;
let initPromise: Promise<void> | null = null;
const listeners = new Set<(d: Downloads) => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// Only one book and one file download at a time. `runToken` invalidates a running loop when the
// active book is removed, so a late status callback can't resurrect it.
let running = false;
let runningHash = '';
let runToken = 0;
let activeTask: DownloadTask | null = null;
let activeHash = '';
let wake: (() => void) | null = null;

const emit = () => { for (const l of listeners) l(state); };
function setState(next: Downloads) { state = next; emit(); }

function persistNow() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  void saveDownloads(state);
}
// Progress fires often; coalesce writes during a transfer.
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; void saveDownloads(state); }, 700);
}

// ---- Public read API ----

export const getDownloads = (): Downloads => state;

export function subscribeDownloads(fn: (d: Downloads) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => { listeners.delete(fn); };
}

export const totalBytesUsed = (): number => totalBytes(state);

/** The local file URI for a finished chapter, or null when it still has to be streamed. */
export function localUriFor(hash: string | undefined, fileId: number): string | null {
  if (Platform.OS === 'web' || !hash) return null;
  const book = get(state, hash);
  if (book?.files.find((f) => f.id === fileId)?.status !== 'done') return null;
  try { return fileFor(book!, fileId).uri; } catch { return null; }
}

export const isChapterDownloaded = (hash: string | undefined, fileId: number) => localUriFor(hash, fileId) !== null;

/** Minimal book records for the library when TorBox can't be reached: id, hash, name and files. */
export async function cachedBooks(): Promise<TBTorrent[]> {
  if (Platform.OS === 'web') return [];
  const all = ready ? state : await loadDownloads();
  return Object.values(all)
    .filter((b) => b.files.some((f) => f.status === 'done'))
    .map((b) => ({
      id: b.id, name: b.name, hash: b.hash,
      size: b.files.reduce((n, f) => n + f.size, 0),
      download_finished: true, download_present: true, progress: 1, download_state: 'downloaded',
      files: b.files.map((f) => ({ id: f.id, name: f.name, size: f.size, mimetype: f.mimetype })),
    }));
}

// ---- Lifecycle ----

/** Loads the persisted queue, reconciles it with disk and resumes a book that was running at exit. */
export function initDownloads(t: string): Promise<void> {
  token = t;
  if (Platform.OS === 'web') { ready = true; return Promise.resolve(); }
  return (initPromise ??= initOnce());
}

async function ensureLoaded(): Promise<void> {
  if (ready) return;
  await (initPromise ?? initDownloads(token));
}

async function initOnce(): Promise<void> {
  try {
    const saved = await loadDownloads();
    const { downloads, resume: resumeHashes } = reconcileAfterRestart(saved);
    let next = verifyOnDisk(downloads);
    cleanupFolders(next);
    for (const hash of resumeHashes) {
      const b = get(next, hash);
      if (b && !isComplete(b)) next = upsert(next, resume(b));
    }
    setState(next);
    persistNow();
    if (resumeHashes.length) void pump();
  } catch {
    // File system unavailable: leave downloads empty rather than break the app.
  } finally {
    ready = true;
  }
}

function fileFor(book: DownloadBook, fileId: number): File {
  const f = book.files.find((x) => x.id === fileId);
  return new File(Paths.document, BOOKS_DIR, book.hash, `${fileId}${f ? fileExt(f.name) : ''}`);
}
const dirFor = (book: DownloadBook) => new Directory(Paths.document, BOOKS_DIR, book.hash);

function freeSpace(): number | null {
  try {
    const n = Paths.availableDiskSpace;
    return Number.isFinite(n) && n >= 0 ? n : null; // a read that fails or is nonsense is unknown, not full
  } catch { return null; }
}

function hasSpace(book: DownloadBook): boolean {
  return enoughSpace(freeSpace(), remainingBytes(book), DISK_MARGIN_BYTES);
}

/** Re-checks every "done" file against its real size; a short file is queued to download again. */
function verifyOnDisk(downloads: Downloads): Downloads {
  let out = downloads;
  for (const book of Object.values(downloads)) {
    const onDisk: Record<number, number> = {};
    for (const f of book.files) {
      try { const file = fileFor(book, f.id); onDisk[f.id] = file.exists ? file.size : -1; }
      catch { onDisk[f.id] = -1; }
    }
    out = upsert(out, verifyFiles(book, onDisk));
  }
  return out;
}

/** Deletes folders for hashes with no download record, plus stale/partial files inside the rest. */
function cleanupFolders(downloads: Downloads): void {
  let root: Directory;
  try { root = new Directory(Paths.document, BOOKS_DIR); } catch { return; }
  if (!root.exists) return;
  let entries: (File | Directory)[];
  try { entries = root.list(); } catch { return; }
  for (const entry of entries) {
    if (entry instanceof Directory) {
      const book = get(downloads, entry.name);
      if (!book) { try { entry.delete(); } catch { /* ignore */ } }
      else cleanupBookDir(entry, book);
    } else {
      try { entry.delete(); } catch { /* ignore */ }
    }
  }
}

function cleanupBookDir(dir: Directory, book: DownloadBook): void {
  const keep = new Set(book.files.filter((f) => f.status === 'done').map((f) => `${f.id}${fileExt(f.name)}`));
  let entries: (File | Directory)[];
  try { entries = dir.list(); } catch { return; }
  for (const entry of entries) {
    if (entry instanceof Directory) { try { entry.delete(); } catch { /* ignore */ } continue; }
    // .part files are not resumable across launches, and a final file that isn't recorded as done
    // (a crashed rename, or a failed size check) is stale.
    if (entry.name.endsWith('.part') || !keep.has(entry.name)) { try { entry.delete(); } catch { /* ignore */ } }
  }
}

// ---- Actions ----

export async function queueBook(book: TBTorrent): Promise<void> {
  if (Platform.OS === 'web') return;
  await ensureLoaded();
  if (!book.hash) throw new Error('This book has no info hash to download by.');
  const key = bookKey(book.hash);
  const existing = get(state, key);
  if (existing) {
    if (isComplete(existing)) return; // already here
    setState(upsert(state, resume(existing))); // pick up where it left off
    persistNow();
    void pump();
    return;
  }
  const record = createBook({
    id: book.id, hash: book.hash, name: book.name,
    files: chapterList(book).map((f) => ({ id: f.id, name: f.name, size: f.size, mimetype: f.mimetype })),
  });
  if (!record.files.length) throw new Error('No audio files to download');
  const need = remainingBytes(record);
  if (!enoughSpace(freeSpace(), need, DISK_MARGIN_BYTES)) {
    throw new Error(`Not enough free space: ${formatBytes(need)} needed plus a 200 MB margin`);
  }
  setState(upsert(state, record));
  persistNow();
  void pump();
}

export function pauseDownload(hash: string): void {
  if (Platform.OS === 'web') return;
  const key = bookKey(hash);
  const b = get(state, key);
  if (!b) return;
  setState(upsert(state, pause(b)));
  persistNow();
  if (runningHash === key) {
    if (activeTask) { try { activeTask.pauseAsync(); } catch { /* already gone */ } }
    wake?.();
  }
}

export function resumeDownload(hash: string): void {
  if (Platform.OS === 'web') return;
  const b = get(state, hash);
  if (!b) return;
  setState(upsert(state, resume(b)));
  persistNow();
  void pump();
}

export async function removeDownload(hash: string): Promise<void> {
  if (Platform.OS === 'web') return;
  const key = bookKey(hash);
  const b = get(state, key);
  if (!b) return;
  // Only invalidate the loop and cancel the task when this is the book being worked on.
  if (runningHash === key) {
    runToken++;
    if (activeTask) { try { activeTask.cancel(); } catch { /* ignore */ } activeTask = null; }
    activeHash = '';
    wake?.();
  }
  setState(remove(state, key));
  persistNow();
  try { const dir = dirFor(b); if (dir.exists) dir.delete(); } catch { /* ignore */ }
  void pump();
}

export async function removeAllDownloads(): Promise<void> {
  if (Platform.OS === 'web') return;
  runToken++;
  runningHash = '';
  if (activeTask) { try { activeTask.cancel(); } catch { /* ignore */ } activeTask = null; activeHash = ''; }
  wake?.();
  setState({});
  persistNow();
  try { const root = new Directory(Paths.document, BOOKS_DIR); if (root.exists) root.delete(); } catch { /* ignore */ }
}

/** A local chapter failed to play: drop it from disk so it downloads again later, without auto-starting. */
export function markFileForRedownload(hash: string | undefined, fileId: number): void {
  if (Platform.OS === 'web' || !hash) return;
  const key = bookKey(hash);
  const b = get(state, key);
  if (!b || !b.files.some((f) => f.id === fileId)) return;
  setState(upsert(state, markForRedownload(b, fileId)));
  persistNow();
  try { const f = fileFor(b, fileId); if (f.exists) f.delete(); } catch { /* ignore */ }
}

// ---- Download loop ----

function pump(): void {
  if (Platform.OS === 'web' || running) return;
  if (activeBook(state)) return;
  const queued = nextQueued(state);
  if (!queued) return;
  setState(upsert(state, start(queued)));
  persistNow();
  void runBook(queued.hash);
}

async function runBook(hash: string): Promise<void> {
  running = true;
  runningHash = hash;
  const my = ++runToken;
  try {
    while (my === runToken) {
      const book = get(state, hash);
      if (!book || book.status !== 'downloading') break;
      const file = currentFile(book);
      if (!file) { setState(upsert(state, setBookStatus(book, 'complete'))); persistNow(); break; }
      if (!hasSpace(book)) {
        setState(upsert(state, setBookStatus(book, 'failed', 'Not enough free space to download this book')));
        persistNow();
        break;
      }
      const outcome = await attemptFile(book, file.id, my);
      if (my !== runToken) break;
      const after = get(state, hash);
      if (!after || after.status !== 'downloading') break; // paused or removed mid-file
      if (outcome === 'done') continue;
      if (outcome === 'pause') break;
      const retry = currentFile(after);
      if (!retry) continue;
      await wait(backoffMs(retry.attempts));
      if (my !== runToken) break;
    }
  } finally {
    running = false;
    runningHash = '';
    if (activeHash === hash) { activeHash = ''; activeTask = null; }
    // Always hand off: another book may be queued, and a remove() call may have asked for a pump
    // while we were still winding down.
    void pump();
  }
}

async function attemptFile(book: DownloadBook, fileId: number, my: number): Promise<'done' | 'pause' | 'error'> {
  const key = book.hash;
  const current = get(state, key);
  if (current) { setState(upsert(state, beginFile(current, fileId))); persistSoon(); }
  try {
    // A fresh link is requested right before each file: the previous one will have expired.
    const url = await getStreamUrl(token, book.id, fileId);
    if (my !== runToken) return 'pause';
    const stillRunning = get(state, key);
    if (!stillRunning || stillRunning.status !== 'downloading') return 'pause'; // paused while the link was fetched
    const dir = dirFor(book);
    if (!dir.exists) dir.create({ intermediates: true });
    const f = book.files.find((x) => x.id === fileId)!;
    const name = `${fileId}${fileExt(f.name)}`;
    const temp = new File(dir, `${name}.part`);
    if (temp.exists) temp.delete();
    const task = File.createDownloadTask(url, temp, {
      onProgress: ({ bytesWritten }) => {
        if (my !== runToken) return;
        const cur = get(state, key);
        if (!cur || cur.status !== 'downloading') return;
        setState(upsert(state, recordBytes(cur, fileId, bytesWritten)));
        persistSoon();
      },
    });
    activeTask = task;
    activeHash = key;
    let result: File | null;
    try {
      result = await task.downloadAsync();
    } finally {
      if (activeTask === task) { activeTask = null; activeHash = ''; }
    }
    if (my !== runToken) return 'pause';
    const cur = get(state, key);
    if (!cur || cur.status !== 'downloading') return 'pause'; // the user paused us
    if (!result) return 'pause';
    if (result.size === f.size) {
      const final = new File(dir, name);
      if (final.exists) final.delete();
      await temp.move(final, { overwrite: true });
      setState(upsert(state, settleFile(cur, fileId, result.size)));
      persistNow();
      return 'done';
    }
    setState(upsert(state, failFile(cur, fileId, 'Downloaded file didn’t match its expected size')));
    persistSoon();
    return 'error';
  } catch (e: any) {
    if (my !== runToken) return 'pause';
    const cur = get(state, key);
    if (!cur || cur.status !== 'downloading') return 'pause';
    setState(upsert(state, failFile(cur, fileId, e?.message ?? 'Download failed')));
    persistSoon();
    return 'error';
  }
}

/** Sleeps until the backoff elapses or an action (pause/remove) wakes us early. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(t); wake = null; resolve(); };
  });
}
