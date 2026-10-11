// The pure half of offline downloads: the queue, the per-file state machine and the "is this file
// done / which files still need downloading" decisions. Deliberately free of React Native, Expo and
// storage imports so the Node test runner (test/downloads.test.ts) can exercise it directly, and so
// the file-system/network half in ./index.ts stays a thin driver around it.

export type FileStatus = 'pending' | 'downloading' | 'done' | 'failed';
export type BookStatus = 'queued' | 'downloading' | 'paused' | 'failed' | 'complete';

export type DownloadFile = {
  id: number;
  name: string;
  size: number;
  /** TorBox's mime type, kept so a reconstructed offline book still recognizes the chapter. */
  mimetype?: string;
  status: FileStatus;
  /** Bytes written so far, for the progress indicator. */
  received: number;
  /** Failed attempts for this file; reset on manual resume or success. */
  attempts: number;
  error?: string;
};

export type DownloadBook = {
  /** TorBox torrent id, needed to request fresh stream links. */
  id: number;
  /** Info hash, lowercased. Also the on-disk folder name. */
  hash: string;
  name: string;
  /** Audio files in chapter order. */
  files: DownloadFile[];
  status: BookStatus;
  error?: string;
  /** Insertion time, so the queue stays FIFO. */
  added: number;
  updated: number;
};

/** The persisted document, keyed by lowercased info hash. */
export type Downloads = Record<string, DownloadBook>;

/** How many times one file is retried before the whole book is marked failed. */
export const MAX_FILE_ATTEMPTS = 3;

/** Backoff before each retry, indexed by the attempt that just failed. */
export const BACKOFF_MS = [2_000, 5_000, 10_000];

/** Kept free on top of a book's remaining bytes before a download may start. */
export const DISK_MARGIN_BYTES = 200 * 1024 * 1024;

/**
 * Whether a download may proceed. Unknown free space (null) is never blocked: we cannot know, and a
 * full disk is exactly 0, which must fail. Otherwise the needed bytes plus the margin must fit.
 */
export function enoughSpace(free: number | null, needed: number, margin: number): boolean {
  return free === null || free >= needed + margin;
}

export const bookKey = (hash: string) => hash.toLowerCase();

export function backoffMs(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[i];
}

/** A fresh, queued record for a book, every file pending. */
export function createBook(
  input: { id: number; hash: string; name: string; files: { id: number; name: string; size: number; mimetype?: string }[] },
  now = Date.now(),
): DownloadBook {
  return {
    id: input.id,
    hash: bookKey(input.hash),
    name: input.name,
    files: input.files.map((f) => ({ id: f.id, name: f.name, size: f.size, mimetype: f.mimetype, status: 'pending' as const, received: 0, attempts: 0 })),
    status: 'queued',
    added: now,
    updated: now,
  };
}

export function get(downloads: Downloads, hash: string): DownloadBook | undefined {
  return downloads[bookKey(hash)];
}

export function upsert(downloads: Downloads, book: DownloadBook): Downloads {
  return { ...downloads, [book.hash]: book };
}

export function remove(downloads: Downloads, hash: string): Downloads {
  const key = bookKey(hash);
  if (!(key in downloads)) return downloads;
  const next = { ...downloads };
  delete next[key];
  return next;
}

// ---- Queries ----

export function usedBytes(book: DownloadBook): number {
  return book.files.reduce((n, f) => n + (f.status === 'done' ? f.size : 0), 0);
}

/** Bytes still to fetch: every file that is not finished, at its full size. */
export function remainingBytes(book: DownloadBook): number {
  return book.files.reduce((n, f) => n + (f.status === 'done' ? 0 : f.size), 0);
}

export function progressFraction(book: DownloadBook): number {
  const total = book.files.reduce((n, f) => n + f.size, 0);
  if (total <= 0) return 1;
  const got = book.files.reduce((n, f) => n + (f.status === 'done' ? f.size : Math.min(Math.max(f.received, 0), f.size)), 0);
  return Math.min(1, got / total);
}

export function isComplete(book: DownloadBook): boolean {
  return book.files.length > 0 && book.files.every((f) => f.status === 'done');
}

/** A file is done only when the bytes on disk match TorBox exactly. */
export function sizeMatches(file: DownloadFile, actualBytes: number): boolean {
  return actualBytes === file.size;
}

export function isChapterDownloaded(book: DownloadBook | undefined, fileId: number): boolean {
  return !!book?.files.some((f) => f.id === fileId && f.status === 'done');
}

/** Local playback when the chapter is finished; otherwise it must be streamed. */
export function chapterSource(book: DownloadBook | undefined, fileId: number): 'local' | 'stream' {
  return isChapterDownloaded(book, fileId) ? 'local' : 'stream';
}

/** The next file to fetch: the first one not finished, in chapter order. */
export function currentFile(book: DownloadBook): DownloadFile | undefined {
  return book.files.find((f) => f.status !== 'done');
}

export function activeBook(downloads: Downloads): DownloadBook | undefined {
  return Object.values(downloads).find((b) => b.status === 'downloading');
}

/** One book downloads at a time: the oldest queued record goes next. */
export function nextQueued(downloads: Downloads): DownloadBook | undefined {
  return Object.values(downloads)
    .filter((b) => b.status === 'queued')
    .sort((a, b) => a.added - b.added || a.id - b.id)[0];
}

export function totalBytes(downloads: Downloads): number {
  return Object.values(downloads).reduce((n, b) => n + usedBytes(b), 0);
}

// ---- Transitions ----

export function setBookStatus(book: DownloadBook, status: BookStatus, error?: string, now = Date.now()): DownloadBook {
  return { ...book, status, error: status === 'failed' ? error : undefined, updated: now };
}

export function start(book: DownloadBook, now = Date.now()): DownloadBook {
  return { ...book, status: 'downloading', error: undefined, updated: now };
}

/** Manual pause: the in-flight file goes back to pending and waits for a resume. */
export function pause(book: DownloadBook, now = Date.now()): DownloadBook {
  return {
    ...book,
    status: 'paused',
    files: book.files.map((f) => (f.status === 'downloading' ? { ...f, status: 'pending' as const, received: 0 } : f)),
    updated: now,
  };
}

/** Manual resume: finished files are kept, anything failed or interrupted is retried. */
export function resume(book: DownloadBook, now = Date.now()): DownloadBook {
  const files = book.files.map((f) =>
    f.status === 'failed' || f.status === 'downloading'
      ? { ...f, status: 'pending' as const, received: 0, attempts: 0, error: undefined }
      : f);
  const complete = files.length > 0 && files.every((f) => f.status === 'done');
  return { ...book, files, status: complete ? 'complete' : 'queued', error: undefined, updated: now };
}

export function beginFile(book: DownloadBook, fileId: number, now = Date.now()): DownloadBook {
  return {
    ...book,
    files: book.files.map((f) => (f.id === fileId ? { ...f, status: 'downloading' as const, received: 0, error: undefined } : f)),
    updated: now,
  };
}

export function recordBytes(book: DownloadBook, fileId: number, received: number): DownloadBook {
  return {
    ...book,
    files: book.files.map((f) => (f.id === fileId && f.status === 'downloading' ? { ...f, received: Math.max(0, received) } : f)),
  };
}

/** Marks a file finished. Callers must have checked sizeMatches first (or use settleFile). */
export function completeFile(book: DownloadBook, fileId: number, now = Date.now()): DownloadBook {
  const files = book.files.map((f) =>
    f.id === fileId ? { ...f, status: 'done' as const, received: f.size, attempts: 0, error: undefined } : f);
  const complete = files.length > 0 && files.every((f) => f.status === 'done');
  return { ...book, files, status: complete ? 'complete' : book.status, error: complete ? undefined : book.error, updated: now };
}

/** Records a failed attempt; after MAX_FILE_ATTEMPTS the whole book is failed. */
export function failFile(book: DownloadBook, fileId: number, error: string, now = Date.now()): DownloadBook {
  const files = book.files.map((f) => (f.id === fileId ? { ...f, attempts: f.attempts + 1, error } : f));
  const f = files.find((x) => x.id === fileId);
  const capped = !!f && f.attempts >= MAX_FILE_ATTEMPTS;
  return {
    ...book,
    files: files.map((x) => (x.id === fileId ? { ...x, status: (capped ? 'failed' : 'pending') as FileStatus } : x)),
    status: capped ? 'failed' : book.status,
    error: capped ? error : book.error,
    updated: now,
  };
}

/** A finished transfer whose on-disk size is wrong counts as a failure, not a done file. */
export function settleFile(book: DownloadBook, fileId: number, actualBytes: number, now = Date.now()): DownloadBook {
  const f = book.files.find((x) => x.id === fileId);
  if (!f) return book;
  if (sizeMatches(f, actualBytes)) return completeFile(book, fileId, now);
  return failFile(book, fileId, 'Downloaded file didn’t match its expected size', now);
}

/** Reconciles a record with what is actually on disk; anything short is queued to download again. */
export function verifyFiles(book: DownloadBook, onDisk: Record<number, number>, now = Date.now()): DownloadBook {
  const files = book.files.map((f) => {
    if (sizeMatches(f, onDisk[f.id] ?? -1)) {
      return { ...f, status: 'done' as const, received: f.size, attempts: 0, error: undefined };
    }
    if (f.status === 'done') return { ...f, status: 'pending' as const, received: 0, error: undefined };
    return f;
  });
  const complete = files.length > 0 && files.every((f) => f.status === 'done');
  let status = book.status;
  if (complete) status = 'complete';
  else if (status === 'complete') status = 'paused'; // files vanished under a finished book
  return { ...book, files, status, updated: now };
}

/** A local file failed to play: forget it so it is fetched again, without auto-starting. */
export function markForRedownload(book: DownloadBook, fileId: number, now = Date.now()): DownloadBook {
  const files = book.files.map((f) =>
    f.id === fileId ? { ...f, status: 'pending' as const, received: 0, attempts: 0, error: undefined } : f);
  return {
    ...book,
    files,
    status: book.status === 'complete' ? 'paused' : book.status,
    error: undefined,
    updated: now,
  };
}

/**
 * On launch, a book left mid-download is no longer running. It shows as paused unless it was the one
 * actively downloading when the app closed, in which case its hash is returned so the caller may
 * resume it. Queued books that were never started are never auto-started.
 */
export function reconcileAfterRestart(downloads: Downloads, now = Date.now()): { downloads: Downloads; resume: string[] } {
  const resume: string[] = [];
  const out: Downloads = {};
  for (const book of Object.values(downloads)) {
    if (book.status === 'downloading') {
      resume.push(book.hash);
      out[book.hash] = {
        ...book,
        status: 'paused',
        files: book.files.map((f) => (f.status === 'downloading' ? { ...f, status: 'pending' as const, received: 0 } : f)),
        updated: now,
      };
    } else {
      out[book.hash] = book;
    }
  }
  return { downloads: out, resume };
}

/** File extension for the on-disk name, e.g. ".m4b". Falls back to ".bin". */
export function fileExt(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? `.${m[1].toLowerCase()}` : '.bin';
}
