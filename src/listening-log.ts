// Listening stats: the log of how long each device has listened to each book on each local day,
// the rule that turns playback ticks into logged seconds, the cross-device merge, and the pure
// stats derived from the log. Deliberately free of react-native/expo imports (like
// src/sync/merge.ts and src/shelf.ts), so the Node test runner covers it (test/listening.test.ts).
//
// Shape: { [deviceId]: { [day 'YYYY-MM-DD' local]: { [torrentId]: { book, wall } } } }.
// `book` is listened media (book) seconds, so at 1.5x an hour of wall clock counts 1.5 h; `wall` is
// the wall-clock seconds that produced them. Each device only ever grows its own leaves, so the
// cross-device merge takes the larger value (max) and is idempotent.

export type ListeningLeaf = { book: number; wall: number };
/** One day on one device: torrent id -> seconds. */
export type ListeningDay = Record<string, ListeningLeaf>;
/** One device: local day -> that day's books. */
export type ListeningDevice = Record<string, ListeningDay>;
/** Every device's log, as it rides the sync document's top-level `listening` key. */
export type ListeningLog = Record<string, ListeningDevice>;

/** Wall-clock seconds on a day needed to count as a listening day for the streaks. */
export const STREAK_MIN_WALL = 5 * 60;

/** How much faster than real time an advance may look before it is treated as a seek/jump. */
const PLAUSIBLE_FACTOR = 3;
/** Slack, in seconds, allowed on top of the plausible advance (a tick can straddle a rate change). */
const PLAUSIBLE_SLACK = 1;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

const isRealAt = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** `YYYY-MM-DD` for a wall-clock millisecond instant, in the device's local time. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Days since the epoch for a `YYYY-MM-DD` string, or null when it is not one. UTC on purpose:
 *  it only orders local calendar days and measures the gap between them, so DST cannot shift it. */
export function dayIndex(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Math.floor(Date.UTC(y, mo - 1, d) / 86_400_000);
}

/** Days since the epoch of the local calendar day `ms` falls on. */
export function localDayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/**
 * The listened media seconds to log for one playback tick, or 0 when the movement is not real
 * playback. An advance is plausible when 0 < advance <= 3 x wall x rate + 1; a seek, a chapter jump
 * or a recovery reload moves the position further than that and is dropped.
 */
export function plausibleBookSeconds(advance: number, wallSeconds: number, rate: number): number {
  if (!Number.isFinite(advance) || !Number.isFinite(wallSeconds) || !Number.isFinite(rate)) return 0;
  if (advance <= 0 || wallSeconds < 0) return 0;
  const max = PLAUSIBLE_FACTOR * wallSeconds * Math.max(0, rate) + PLAUSIBLE_SLACK;
  return advance <= max ? advance : 0;
}

/** Where the previous playback observation left the position, for the next one to measure against. */
export type ListenAnchor = { torrentId: number; position: number; at: number } | null;

/**
 * One playback status observation. `prev` is the anchor of the previous observation of the same
 * book, or null when nothing is playing / the book just changed. Returns the book and wall seconds
 * to add (both 0 when the advance was a jump) and the anchor the next observation should use.
 * Pure and ref-only, so the player can call it on every tick without touching React.
 */
export function listeningAdvance(
  prev: ListenAnchor,
  torrentId: number,
  position: number,
  playing: boolean,
  rate: number,
  now: number,
): { book: number; wall: number; anchor: ListenAnchor } {
  if (!playing || !Number.isFinite(position)) return { book: 0, wall: 0, anchor: null };
  if (!prev || prev.torrentId !== torrentId) return { book: 0, wall: 0, anchor: { torrentId, position, at: now } };
  const wall = (now - prev.at) / 1000;
  const book = plausibleBookSeconds(position - prev.position, wall, rate);
  return { book, wall: book > 0 ? wall : 0, anchor: { torrentId, position, at: now } };
}

/** Adds one observation's seconds into a log in place. Used by the player's in-memory pending log. */
export function addListening(
  log: ListeningLog,
  deviceId: string,
  day: string,
  torrentId: string,
  book: number,
  wall: number,
): void {
  if (!deviceId || !day || !torrentId) return;
  if (!(book > 0) && !(wall > 0)) return;
  const device = (log[deviceId] ??= {});
  const d = (device[day] ??= {});
  const leaf = (d[torrentId] ??= { book: 0, wall: 0 });
  leaf.book += Math.max(0, book);
  leaf.wall += Math.max(0, wall);
}

/** Adds every leaf of `patch` into `target` in place, keeping keys that only one side has. */
export function addListeningLog(target: ListeningLog, patch: ListeningLog): void {
  for (const [deviceId, days] of Object.entries(patch ?? {})) {
    if (!isObj(days)) continue;
    for (const [day, torrents] of Object.entries(days)) {
      if (!isObj(torrents)) continue;
      for (const [torrentId, leaf] of Object.entries(torrents)) {
        if (!isObj(leaf)) continue;
        addListening(target, deviceId, day, torrentId, num(leaf.book), num(leaf.wall));
      }
    }
  }
}

/**
 * Reads whatever the sync document (or a hand-edited file) holds into a well-formed log. Unknown
 * shapes, malformed days and non-numeric or negative leaves are dropped rather than throwing.
 */
export function parseListening(raw: unknown): ListeningLog {
  const out: ListeningLog = {};
  if (!isObj(raw)) return out;
  for (const [deviceId, days] of Object.entries(raw)) {
    if (!deviceId || !isObj(days)) continue;
    const device: ListeningDevice = {};
    for (const [day, torrents] of Object.entries(days)) {
      if (dayIndex(day) === null || !isObj(torrents)) continue;
      const d: ListeningDay = {};
      for (const [torrentId, leaf] of Object.entries(torrents)) {
        if (!torrentId || !isObj(leaf)) continue;
        const book = leaf.book;
        const wall = leaf.wall;
        // A leaf is only kept when both fields are real, non-negative numbers; otherwise it is junk.
        if (typeof book !== 'number' || !Number.isFinite(book) || book < 0) continue;
        if (typeof wall !== 'number' || !Number.isFinite(wall) || wall < 0) continue;
        if (book <= 0 && wall <= 0) continue;
        d[torrentId] = { book, wall };
      }
      if (Object.keys(d).length) device[day] = d;
    }
    if (Object.keys(device).length) out[deviceId] = device;
  }
  return out;
}

/**
 * Cross-device merge: per device, per day, per book take the larger `book` and the larger `wall`.
 * Each device only ever grows its own leaves, so max is correct; it is also idempotent and
 * commutative, which the sync cycle relies on.
 */
export function mergeListening(a: ListeningLog, b: ListeningLog): ListeningLog {
  const out: ListeningLog = {};
  for (const deviceId of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const da = a?.[deviceId] ?? {};
    const db = b?.[deviceId] ?? {};
    const device: ListeningDevice = {};
    for (const day of new Set([...Object.keys(da), ...Object.keys(db)])) {
      const ta = da[day] ?? {};
      const tb = db[day] ?? {};
      const d: ListeningDay = {};
      for (const torrentId of new Set([...Object.keys(ta), ...Object.keys(tb)])) {
        const la = ta[torrentId];
        const lb = tb[torrentId];
        const book = Math.max(num(la?.book), num(lb?.book));
        const wall = Math.max(num(la?.wall), num(lb?.wall));
        if (book <= 0 && wall <= 0) continue;
        d[torrentId] = { book, wall };
      }
      if (Object.keys(d).length) device[day] = d;
    }
    if (Object.keys(device).length) out[deviceId] = device;
  }
  return out;
}

// ---- Estimate of listening done before tracking existed ----
// A one-time snapshot built from the progress records that were already there. Book time only: the
// wall time behind it is unknowable, so it never touches streaks, the 7-day bars or average speed.

/** Guessed audio bitrate (bits/s) by file extension, for turning a byte size into a length. */
export const AUDIO_BITRATE_BPS: Record<string, number> = {
  mp3: 64_000,
  m4b: 64_000, m4a: 64_000, aac: 64_000,
  ogg: 48_000, oga: 48_000, opus: 48_000,
};
export const DEFAULT_BITRATE_BPS = 64_000;

/** The bitrate guess for a file name: mp3/m4b/m4a/aac 64 kbps, opus/ogg 48 kbps, else 64 kbps. */
export function guessedBitrate(name: string): number {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name ?? '');
  return (m && AUDIO_BITRATE_BPS[m[1].toLowerCase()]) || DEFAULT_BITRATE_BPS;
}

/** Seconds a byte size would last at the guessed bitrate (0 for a non-positive size). */
export function secondsFromBytes(bytes: number, name: string): number {
  if (!(bytes > 0)) return 0;
  return (bytes * 8) / guessedBitrate(name);
}

/** One audio file as the estimate sees it. `duration` is a length the app already knows, if any. */
export type EstimateFile = { id: number; name: string; size: number; duration?: number };

export type EstimateProgress = {
  fileId: number;
  chapterIndex: number;
  position: number;
  duration: number;
  finished?: boolean;
  updated: number;
};

/** One book to estimate, with its chapter-ordered files (from the TorBox listing). */
export type EstimateBookInput = {
  torrentId: number;
  files: EstimateFile[];
  progress?: EstimateProgress;
  finishedAt?: number;
};

export type ListeningEstimateBook = { seconds: number; at: number };
/**
 * The one-time snapshot. `books` holds undated lumps (dated `at`); `days` holds seconds attributed
 * to a specific local day by walking the gist's revision history. `source` says which build made it:
 * `'history'` read the gist revisions, `'progress'` only had the current progress records.
 */
export type ListeningEstimate = {
  createdAt: number;
  books: Record<string, ListeningEstimateBook>;
  days: Record<string, Record<string, number>>;
  source: 'history' | 'progress';
};

/** One revision's progress record (structurally the sync document's ProgressRecord). */
export type RevisionProgress = {
  fileId: number;
  chapterIndex: number;
  position: number;
  duration: number;
  finished?: boolean;
};
/** A parsed gist revision: when it was committed and its progress, already keyed by torrent id. */
export type ListeningRevision = { at: number; progress: Record<string, RevisionProgress> };
/** The reconstruction result: book seconds per local day, and each book's total. */
export type ListeningHistory = { days: Record<string, Record<string, number>>; secondsByTorrent: Record<string, number> };

/** A single book's listening on one day can't exceed this; a bigger forward jump is a skip. */
export const HISTORY_DAY_CAP = 16 * 3600;

/** The length of one file, or null when neither a known duration nor a byte size is available. */
function fileSeconds(file: EstimateFile, progress: EstimateProgress | undefined, current: boolean): number | null {
  if (current && progress && progress.duration > 0) return progress.duration;
  if (file.duration != null && file.duration > 0) return file.duration;
  if (file.size > 0) return secondsFromBytes(file.size, file.name);
  return null;
}

/**
 * The absolute book seconds a progress record stands at: the whole book for a finished record, else
 * the files before `chapterIndex` plus the position. Null when a needed length is unknown.
 */
function progressSeconds(files: EstimateFile[], progress: RevisionProgress): number | null {
  return estimateBookSeconds({ torrentId: 0, files, progress: { ...progress, updated: 0 }, finishedAt: progress.finished ? 1 : undefined });
}

/**
 * Walks the gist revisions and attributes each book's listening to a local day. Only the last
 * revision of each day counts. A book's first appearance counts its whole position on that day
 * (listening from before sync existed lands on the day sync first saw it); later days add the
 * forward difference, and a backward move adds nothing. One day is capped at HISTORY_DAY_CAP.
 */
export function reconstructHistory(
  revisions: ListeningRevision[],
  filesByTorrent: Record<string, EstimateFile[]>,
): ListeningHistory {
  // book -> day -> the last (latest) revision's absolute position that day.
  const lastByBookDay = new Map<string, Map<string, { at: number; pos: number }>>();
  for (const rev of [...revisions].sort((a, b) => a.at - b.at)) {
    const day = localDay(rev.at);
    for (const [torrentId, progress] of Object.entries(rev.progress)) {
      const files = filesByTorrent[torrentId];
      if (!files || !files.length) continue;
      const pos = progressSeconds(files, progress);
      if (pos == null) continue;
      let byDay = lastByBookDay.get(torrentId);
      if (!byDay) { byDay = new Map(); lastByBookDay.set(torrentId, byDay); }
      const cur = byDay.get(day);
      if (!cur || rev.at >= cur.at) byDay.set(day, { at: rev.at, pos });
    }
  }

  const days: Record<string, Record<string, number>> = {};
  const secondsByTorrent: Record<string, number> = {};
  for (const [torrentId, byDay] of lastByBookDay) {
    const seq = [...byDay.entries()]
      .map(([day, v]) => ({ day, pos: v.pos }))
      .sort((a, b) => (dayIndex(a.day) ?? 0) - (dayIndex(b.day) ?? 0));
    let prev: number | null = null;
    for (const { day, pos } of seq) {
      const first = prev === null;
      let seconds = first ? pos : Math.max(0, pos - prev!);
      prev = pos;
      if (seconds <= 0) continue;
      // A big jump between two days is a skip. Not on the first sighting: that is everything listened
      // before sync existed, landing on the day sync first saw the book.
      if (!first && seconds > HISTORY_DAY_CAP) seconds = HISTORY_DAY_CAP;
      (days[day] ??= {})[torrentId] = (days[day][torrentId] ?? 0) + seconds;
      secondsByTorrent[torrentId] = (secondsByTorrent[torrentId] ?? 0) + seconds;
    }
  }
  return { days, secondsByTorrent };
}

/**
 * Estimated book seconds listened for one book. Finished: the whole book's length. Otherwise the sum
 * of the files before `chapterIndex` plus the position. Returns null when a needed length is unknown
 * (the caller then retries later instead of saving a partial snapshot). The current file's length, if
 * known, comes from `progress.duration`; other files' lengths come from their byte size and the
 * guessed bitrate. The position is clamped to the current file's known duration.
 */
export function estimateBookSeconds(input: EstimateBookInput): number | null {
  const { files, progress } = input;
  if (!files.length) return null;
  const finished = !!progress?.finished || isRealAt(input.finishedAt);
  if (finished) {
    let total = 0;
    for (const f of files) {
      const s = fileSeconds(f, progress, !!progress && progress.fileId === f.id);
      if (s == null) return null;
      total += s;
    }
    return total;
  }
  if (!progress) return null;
  const idx = Math.min(Math.max(0, Math.floor(progress.chapterIndex)), files.length - 1);
  let total = 0;
  for (let i = 0; i < idx; i++) {
    const s = fileSeconds(files[i], progress, false);
    if (s == null) return null;
    total += s;
  }
  const position = Math.max(0, progress.position);
  total += progress.duration > 0 ? Math.min(position, progress.duration) : position;
  return total;
}

/**
 * Builds the snapshot from the books that already have progress or a finish date, with no day
 * attribution (source `progress`). Used when there is no sync history to read.
 */
export function buildListeningEstimate(entries: EstimateBookInput[], now: number): ListeningEstimate {
  const books: Record<string, ListeningEstimateBook> = {};
  for (const e of entries) {
    const seconds = estimateBookSeconds(e);
    if (seconds == null || !(seconds > 0)) continue; // a book with an unknown length is left out
    const at = isRealAt(e.finishedAt) ? e.finishedAt : e.progress?.updated;
    if (!isRealAt(at)) continue;
    books[String(e.torrentId)] = { seconds, at };
  }
  return { createdAt: now, books, days: {}, source: 'progress' };
}

/**
 * Builds the snapshot from the gist history plus the current progress. The dated `days` carry the
 * history; each book's unattributed remainder (current position minus what history covered, for
 * devices that were not syncing) stays a lump dated `now`.
 */
export function buildHistoryEstimate(history: ListeningHistory, entries: EstimateBookInput[], now: number): ListeningEstimate {
  const books: Record<string, ListeningEstimateBook> = {};
  for (const e of entries) {
    const current = estimateBookSeconds(e);
    if (current == null) continue;
    const covered = history.secondsByTorrent[String(e.torrentId)] ?? 0;
    const remainder = current - covered;
    // What the history does not cover (a device that was not syncing) is dated like the progress-only
    // estimate: when the book was finished or last played.
    const at = isRealAt(e.finishedAt) ? e.finishedAt : e.progress?.updated;
    if (remainder > 0 && isRealAt(at)) books[String(e.torrentId)] = { seconds: remainder, at };
  }
  return { createdAt: now, books, days: history.days, source: 'history' };
}

/** The total estimated seconds in a snapshot (lumps plus dated days), for the tie-break. */
export function estimateTotal(est: ListeningEstimate): number {
  let n = 0;
  for (const b of Object.values(est.books ?? {})) if (Number.isFinite(b.seconds)) n += b.seconds;
  for (const day of Object.values(est.days ?? {})) {
    for (const seconds of Object.values(day)) if (Number.isFinite(seconds)) n += seconds;
  }
  return n;
}

/**
 * Two devices may each build one. A `history` snapshot always beats a `progress`-only one (a phone
 * that fell back must not win); within the same source the earliest `createdAt` wins, and an exact
 * tie is broken by the larger total, deterministically.
 */
export function mergeListeningEstimates(
  a: ListeningEstimate | null | undefined,
  b: ListeningEstimate | null | undefined,
): ListeningEstimate | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const aHistory = a.source === 'history';
  const bHistory = b.source === 'history';
  if (aHistory !== bHistory) return aHistory ? a : b;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? a : b;
  return estimateTotal(a) >= estimateTotal(b) ? a : b;
}

/** Reads the snapshot from a synced document or a hand-edited file; null when absent/malformed. */
export function parseListeningEstimate(raw: unknown): ListeningEstimate | null {
  if (!isObj(raw)) return null;
  const createdAt = raw.createdAt;
  if (!isRealAt(createdAt)) return null;

  const books: Record<string, ListeningEstimateBook> = {};
  if (isObj(raw.books)) {
    for (const [id, b] of Object.entries(raw.books)) {
      if (!id || !isObj(b)) continue;
      const seconds = b.seconds, at = b.at;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) continue;
      if (!isRealAt(at)) continue;
      books[id] = { seconds, at };
    }
  }
  const days: Record<string, Record<string, number>> = {};
  if (isObj(raw.days)) {
    for (const [day, torrents] of Object.entries(raw.days)) {
      if (dayIndex(day) === null || !isObj(torrents)) continue;
      const d: Record<string, number> = {};
      for (const [id, seconds] of Object.entries(torrents)) {
        if (!id || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) continue;
        d[id] = seconds;
      }
      if (Object.keys(d).length) days[day] = d;
    }
  }
  return { createdAt, books, days, source: raw.source === 'history' ? 'history' : 'progress' };
}

// ---- Stats ----

/** What the stats need to know about a book, keyed by torrent id. */
export type StatsBook = { title?: string; cover?: string; finishedAt?: number };

export type ListeningDayStat = { day: string; book: number; wall: number; /** Estimated part of `book`. */ estBook: number };
export type ListeningTopBook = { torrentId: string; title?: string; cover?: string; book: number; estimated?: boolean };

export type ListeningStats = {
  todayBook: number; todayWall: number;
  weekBook: number; weekWall: number;
  monthBook: number; monthWall: number;
  yearBook: number; yearWall: number;
  allBook: number; allWall: number;
  /** The last seven local days, oldest first, including today. */
  last7: ListeningDayStat[];
  /** Consecutive days with at least STREAK_MIN_WALL wall seconds; today not yet listened is skipped. */
  currentStreak: number;
  longestStreak: number;
  booksFinishedThisYear: number;
  /** The five books with the most book time this calendar year, largest first. */
  topBooks: ListeningTopBook[];
  /** Book time divided by wall time: 1.5 means the books ran at 1.5x on average. From tracked time only. */
  averageSpeed: number;
  /** Estimated book seconds (before tracking) that fall in each period. Never counted in walls. */
  estToday: number; estWeek: number; estMonth: number; estYear: number; estAll: number;
};

const sumLeaves = (torrents: ListeningDay, pick: (l: ListeningLeaf) => number) =>
  Object.values(torrents).reduce((n, l) => n + pick(l), 0);

/** The local calendar days and derived totals the stats need, computed once. */
function scan(log: ListeningLog) {
  const byDay = new Map<string, { book: number; wall: number }>();
  let allBook = 0, allWall = 0;
  for (const device of Object.values(log ?? {})) {
    for (const [day, torrents] of Object.entries(device ?? {})) {
      const book = sumLeaves(torrents, (l) => num(l.book));
      const wall = sumLeaves(torrents, (l) => num(l.wall));
      allBook += book; allWall += wall;
      const cur = byDay.get(day) ?? { book: 0, wall: 0 };
      cur.book += book; cur.wall += wall;
      byDay.set(day, cur);
    }
  }
  return { byDay, allBook, allWall };
}

const sumWhere = (byDay: Map<string, { book: number; wall: number }>, pred: (day: string) => boolean) => {
  let book = 0, wall = 0;
  for (const [day, t] of byDay) if (pred(day)) { book += t.book; wall += t.wall; }
  return { book, wall };
};

/** Local-day index -> whether the day had enough wall time to count for the streaks. */
function streakDays(byDay: Map<string, { book: number; wall: number }>): Set<number> {
  const active = new Set<number>();
  for (const [day, t] of byDay) if (t.wall >= STREAK_MIN_WALL) {
    const i = dayIndex(day);
    if (i !== null) active.add(i);
  }
  return active;
}

function longestRun(active: Set<number>): number {
  const sorted = [...active].sort((a, b) => a - b);
  let longest = 0, run = 0, prev: number | null = null;
  for (const i of sorted) {
    run = prev !== null && i === prev + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = i;
  }
  return longest;
}

/** The run ending today, or ending yesterday when today has not been listened to yet. */
function currentRun(active: Set<number>, today: number): number {
  let start: number | null = null;
  if (active.has(today)) start = today;
  else if (active.has(today - 1)) start = today - 1;
  if (start === null) return 0;
  let n = 0;
  for (let i = start; active.has(i); i--) n++;
  return n;
}

/**
 * Everything the stats screen shows, given the log, the books (finished dates, titles, covers) and
 * "now". All sums add up every device because the log is the merge of all of them. An optional
 * estimate snapshot adds book time to the period containing each book's `at`, but never to the
 * 7-day bars, streaks, wall totals or average speed (its wall time is unknowable).
 */
export function listeningStats(
  log: ListeningLog,
  books: Record<string, StatsBook>,
  now: number,
  estimate: ListeningEstimate | null = null,
): ListeningStats {
  const today = localDay(now);
  const yearStr = today.slice(0, 4);
  const monthStr = today.slice(0, 7);
  const todayIdx = localDayIndex(now);
  const yearNum = Number(yearStr);

  // The Mon–Sun week around `now`, built from local calendar parts (noon avoids any DST edge).
  const base = new Date(now);
  base.setHours(12, 0, 0, 0);
  const daysFromMonday = (base.getDay() + 6) % 7;
  const monday = new Date(base);
  monday.setDate(base.getDate() - daysFromMonday);
  const week = new Set<string>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    week.add(localDay(d.getTime()));
  }

  const last7: ListeningDayStat[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    last7.push({ day: localDay(d.getTime()), book: 0, wall: 0, estBook: 0 });
  }
  const { byDay, allBook, allWall } = scan(log);
  for (const d of last7) {
    const t = byDay.get(d.day);
    if (t) { d.book = t.book; d.wall = t.wall; }
  }

  const todayTot = sumWhere(byDay, (day) => day === today);
  const weekTot = sumWhere(byDay, (day) => week.has(day));
  const monthTot = sumWhere(byDay, (day) => day.startsWith(monthStr));
  const yearTot = sumWhere(byDay, (day) => day.startsWith(yearStr));

  // This year's book time per torrent id, for the top list.
  const yearByTorrent = new Map<string, number>();
  for (const device of Object.values(log ?? {})) {
    for (const [day, torrents] of Object.entries(device ?? {})) {
      if (!day.startsWith(yearStr)) continue;
      for (const [torrentId, leaf] of Object.entries(torrents)) {
        yearByTorrent.set(torrentId, (yearByTorrent.get(torrentId) ?? 0) + num(leaf.book));
      }
    }
  }
  // The estimate snapshot adds book time. Dated `days` count on their own day (and on the bars);
  // undated `books` lumps count in the period of `at`, never on a bar. Neither ever touches walls.
  const est = { today: 0, week: 0, month: 0, year: 0, all: 0 };
  const estByTorrentYear = new Map<string, number>();
  const addEstimate = (torrentId: string, seconds: number, day: string) => {
    if (!(seconds > 0)) return;
    est.all += seconds;
    if (day.startsWith(yearStr)) {
      est.year += seconds;
      yearByTorrent.set(torrentId, (yearByTorrent.get(torrentId) ?? 0) + seconds);
      estByTorrentYear.set(torrentId, (estByTorrentYear.get(torrentId) ?? 0) + seconds);
    }
    if (day.startsWith(monthStr)) est.month += seconds;
    if (week.has(day)) est.week += seconds;
    if (day === today) est.today += seconds;
  };
  for (const [day, torrents] of Object.entries(estimate?.days ?? {})) {
    const sum = Object.values(torrents).reduce((n, s) => n + num(s), 0);
    for (const [torrentId, seconds] of Object.entries(torrents)) addEstimate(torrentId, num(seconds), day);
    const d = last7.find((x) => x.day === day);
    if (d) d.estBook += sum;
  }
  for (const [torrentId, b] of Object.entries(estimate?.books ?? {})) {
    if (!isRealAt(b.at)) continue;
    addEstimate(torrentId, b.seconds, localDay(b.at));
  }

  const topBooks: ListeningTopBook[] = [...yearByTorrent.entries()]
    .filter(([, book]) => book > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([torrentId, book]) => {
      const info = books[torrentId];
      return { torrentId, title: info?.title, cover: info?.cover, book, estimated: (estByTorrentYear.get(torrentId) ?? 0) > 0 };
    });

  let booksFinishedThisYear = 0;
  for (const b of Object.values(books ?? {})) {
    if (b && isRealAt(b.finishedAt) && new Date(b.finishedAt).getFullYear() === yearNum) booksFinishedThisYear++;
  }

  const active = streakDays(byDay);
  return {
    todayBook: todayTot.book + est.today, todayWall: todayTot.wall,
    weekBook: weekTot.book + est.week, weekWall: weekTot.wall,
    monthBook: monthTot.book + est.month, monthWall: monthTot.wall,
    yearBook: yearTot.book + est.year, yearWall: yearTot.wall,
    allBook: allBook + est.all, allWall,
    last7,
    currentStreak: currentRun(active, todayIdx),
    longestStreak: longestRun(active),
    booksFinishedThisYear,
    topBooks,
    averageSpeed: allWall > 0 ? allBook / allWall : 0,
    estToday: est.today, estWeek: est.week, estMonth: est.month, estYear: est.year, estAll: est.all,
  };
}

/** "12 h 40 min", "3 h" or "40 min"; zero seconds is "0 min". */
export function formatListening(seconds: number): string {
  const mins = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) / 60));
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

/** Whole hours only, for a total that includes an estimate: "12 h", "under 1 h" or "0 h". */
export function formatListeningHours(seconds: number): string {
  const s = Number.isFinite(seconds) ? seconds : 0;
  const h = Math.round(s / 3600);
  if (h > 0) return `${h} h`;
  return s > 0 ? 'under 1 h' : '0 h';
}
