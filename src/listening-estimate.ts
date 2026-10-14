// Builds the one-time estimate of listening done before tracking existed, and nothing else. When
// sync is configured it dates the past listening from the gist's revision history; otherwise (or
// when the history is gone for good) it falls back to the current progress records. The result is
// frozen, so it never runs twice. It must not block the UI or a sync cycle: it is fire-and-forget.
import { chapterList, type TBTorrent } from './torbox';
import { loadAllReadalong, loadDownloads, loadGistId, loadListeningEstimate, loadMeta, loadProgress, saveListeningEstimate } from './storage';
import {
  buildHistoryEstimate, buildListeningEstimate, reconstructHistory, localDay,
  type EstimateBookInput, type EstimateFile, type ListeningEstimate, type ListeningRevision, type RevisionProgress,
} from './listening-log';
import { listGistCommits, readGistVersion, makeBudget, BudgetExhausted, GistMissing, type GistCommit } from './sync/github';
import { getSyncToken } from './sync';
import { parseDoc } from './sync/merge';
import { emitLocalChange } from './sync/events';

/** The progress records and file lengths the estimate is built from, read once. */
type ProgressData = {
  entries: EstimateBookInput[];
  filesByTorrent: Record<string, EstimateFile[]>;
  hashToId: Map<string, number>;
};

/** The books that already have progress or a finish date, with each book's known file lengths. */
async function progressData(books: TBTorrent[]): Promise<ProgressData | null> {
  const [progress, meta, downloads, readalong] = await Promise.all([
    loadProgress(), loadMeta(), loadDownloads(), loadAllReadalong(),
  ]);
  const entries: EstimateBookInput[] = [];
  const filesByTorrent: Record<string, EstimateFile[]> = {};
  const hashToId = new Map<string, number>();
  for (const book of books) {
    if (!book.hash) continue;
    const hash = book.hash.toLowerCase();
    hashToId.set(hash, book.id);
    const p = progress[String(book.id)];
    const finishedAt = meta[hash]?.finishedAt;
    if (!p && !finishedAt) continue; // nothing listened before tracking

    // The read-along builder stored each file's duration; it is the best length the app has.
    const knownDuration = new Map((readalong[hash]?.files ?? []).map((f) => [f.id, f.duration]));
    const files = chapterList(book).map((f) => {
      const downloaded = downloads[hash]?.files.find((d) => d.id === f.id);
      // The listing's size is authoritative; a downloaded file's size covers a listing with no sizes.
      return { id: f.id, name: f.name, size: f.size || downloaded?.size || 0, duration: knownDuration.get(f.id) };
    });
    if (!files.length) return null; // the torrent listing is not ready: retry later

    entries.push({ torrentId: book.id, files, progress: p, finishedAt });
    filesByTorrent[String(book.id)] = files;
  }
  return { entries, filesByTorrent, hashToId };
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Dates the past listening from the gist's revision history. Only the last revision of each local
 * day is read; the version fetches stop when the request budget is spent, so the oldest days become
 * unknown (their time stays in the remainder lump). Null when there is no usable history to read.
 */
async function buildFromHistory(token: string, gistId: string, data: ProgressData): Promise<ListeningEstimate | null> {
  const budget = makeBudget();
  const commits = await listGistCommits(token, gistId, undefined, budget);
  if (!commits.length) return null;

  // Newest first: the first commit seen for a day is that day's last revision.
  const seenDays = new Set<string>();
  const chosen: { at: number; commit: GistCommit }[] = [];
  for (const commit of commits) {
    const at = Date.parse(commit.committed_at);
    if (!Number.isFinite(at)) continue;
    const day = localDay(at);
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    chosen.push({ at, commit });
  }
  chosen.sort((a, b) => b.at - a.at); // recent days survive a tight budget

  const revisions = await mapLimit(chosen, 4, async (item): Promise<ListeningRevision | null> => {
    if (budget.remaining <= 0) return null;
    let content: string | null;
    try {
      content = await readGistVersion(token, gistId, item.commit.version, undefined, budget);
    } catch (e) {
      if (e instanceof BudgetExhausted) return null;
      throw e; // a network/HTTP failure: the whole run saves nothing and retries next launch
    }
    if (!content) return null;
    let doc;
    try { doc = parseDoc(JSON.parse(content)); } catch { return null; }
    const progress: Record<string, RevisionProgress> = {};
    for (const [hash, p] of Object.entries(doc.progress)) {
      const id = data.hashToId.get(hash.toLowerCase());
      if (id === undefined) continue;
      progress[String(id)] = { fileId: p.fileId, chapterIndex: p.chapterIndex, position: p.position, duration: p.duration, finished: p.finished };
    }
    return { at: item.at, progress };
  });

  const usable = revisions.filter((r): r is ListeningRevision => !!r);
  if (!usable.length) return null;
  const history = reconstructHistory(usable, data.filesByTorrent);
  return buildHistoryEstimate(history, data.entries, Date.now());
}

async function run(books: TBTorrent[]): Promise<boolean> {
  const existing = await loadListeningEstimate();
  if (existing?.source === 'history') return false; // already dated from history: frozen

  const data = await progressData(books);
  if (!data) return false; // the listing is not ready: retry next launch

  const token = getSyncToken();
  const gistId = await loadGistId();
  if (token && gistId) {
    try {
      const estimate = await buildFromHistory(token, gistId, data);
      if (estimate) {
        await saveListeningEstimate(estimate);
        emitLocalChange(); // push it on the next sync
        return true;
      }
      // No commits or no usable revision: fall back to the progress-only estimate below.
    } catch (e) {
      if (!(e instanceof GistMissing)) return false; // network/HTTP: save nothing, retry next launch
      // The gist is gone for good: fall back to the progress-only estimate below.
    }
  }

  // Keep an existing (progress-only) snapshot rather than replacing it with a fresh one; a later
  // launch with the gist reachable can still upgrade it to a dated history snapshot.
  if (existing) return false;

  const estimate = buildListeningEstimate(data.entries, Date.now());
  await saveListeningEstimate(estimate);
  emitLocalChange();
  return true;
}

let runPromise: Promise<boolean> | null = null;

/**
 * Creates the snapshot once. Safe to call repeatedly: the first call starts the run and later calls
 * share it, so it never runs twice at once. Returns true when a snapshot was created.
 */
export function maybeCreateListeningEstimate(books: TBTorrent[]): Promise<boolean> {
  if (!runPromise) runPromise = run(books).catch(() => false);
  return runPromise;
}
