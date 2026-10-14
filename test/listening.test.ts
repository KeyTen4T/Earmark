import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  plausibleBookSeconds, listeningAdvance, addListening, addListeningLog,
  parseListening, mergeListening, listeningStats, formatListening, formatListeningHours,
  guessedBitrate, secondsFromBytes, DEFAULT_BITRATE_BPS,
  estimateBookSeconds, buildListeningEstimate, buildHistoryEstimate, reconstructHistory,
  mergeListeningEstimates, parseListeningEstimate, HISTORY_DAY_CAP,
  STREAK_MIN_WALL, type ListeningLog, type ListeningEstimate, type EstimateProgress,
  type EstimateFile, type ListeningRevision, type RevisionProgress,
} from '../src/listening-log';
import { parseDoc, mergeDocs, emptyDoc } from '../src/sync/merge';

// A fixed Monday, so the Mon–Sun week is unambiguous (2026-06-15).
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const log = (device: string, day: string, torrent: string, book: number, wall: number): ListeningLog =>
  ({ [device]: { [day]: { [torrent]: { book, wall } } } });

// ---- The accumulation rule ----

test('listening: at 1x an advance of the wall time is logged as book time', () => {
  assert.equal(plausibleBookSeconds(10, 10, 1), 10);
  // At 1.5x an hour of wall clock is 1.5 h of book.
  assert.equal(plausibleBookSeconds(15, 10, 1.5), 15);
  assert.equal(plausibleBookSeconds(90, 60, 1.5), 90);
});

test('listening: a seek, a jump or a stall adds nothing', () => {
  assert.equal(plausibleBookSeconds(300, 1, 1), 0); // a seek forward
  assert.equal(plausibleBookSeconds(-20, 1, 1), 0); // a rewind
  assert.equal(plausibleBookSeconds(0, 1, 1), 0); // no movement
  assert.equal(plausibleBookSeconds(NaN, 1, 1), 0);
  assert.equal(plausibleBookSeconds(10, -1, 1), 0);
});

test('listening: the plausible boundary is 3 x wall x rate + 1', () => {
  assert.equal(plausibleBookSeconds(31, 10, 1), 31); // exactly on it
  assert.equal(plausibleBookSeconds(32, 10, 1), 0); // past it
  assert.equal(plausibleBookSeconds(46, 10, 1.5), 46);
  assert.equal(plausibleBookSeconds(47, 10, 1.5), 0);
});

test('listening: the anchor starts, resets on pause and measures only between playing ticks', () => {
  // First playing observation just sets the anchor.
  const a = listeningAdvance(null, 7, 100, true, 1, 1000);
  assert.deepEqual(a, { book: 0, wall: 0, anchor: { torrentId: 7, position: 100, at: 1000 } });
  // Ten seconds later, ten seconds of media: counted.
  const b = listeningAdvance(a.anchor, 7, 110, true, 1, 11_000);
  assert.equal(b.book, 10);
  assert.equal(b.wall, 10);
  // A pause clears the anchor; the next resume adds nothing until it has an anchor again.
  const paused = listeningAdvance(b.anchor, 7, 110, false, 1, 12_000);
  assert.equal(paused.anchor, null);
  const resumed = listeningAdvance(paused.anchor, 7, 110, true, 1, 13_000);
  assert.equal(resumed.book, 0);
  assert.ok(resumed.anchor);
  // A different book resets too.
  const other = listeningAdvance(b.anchor, 8, 500, true, 1, 20_000);
  assert.equal(other.book, 0);
});

test('listening: addListening accumulates, and addListeningLog is additive', () => {
  const a: ListeningLog = {};
  addListening(a, 'dev', '2026-06-15', '1', 10, 12);
  addListening(a, 'dev', '2026-06-15', '1', 5, 6);
  assert.deepEqual(a.dev['2026-06-15']['1'], { book: 15, wall: 18 });
  addListeningLog(a, log('dev', '2026-06-15', '1', 1, 1));
  assert.deepEqual(a.dev['2026-06-15']['1'], { book: 16, wall: 19 });
  // Nothing is created for non-positive input.
  addListening(a, 'dev', '2026-06-15', '2', 0, 0);
  assert.equal('2' in a.dev['2026-06-15'], false);
});

// ---- Merge and parse ----

test('listening: merge takes the larger book and wall per device/day/book', () => {
  const a = log('dev', '2026-06-15', '1', 100, 120);
  const b = log('dev', '2026-06-15', '1', 80, 200); // wall larger, book smaller
  assert.deepEqual(mergeListening(a, b), log('dev', '2026-06-15', '1', 100, 200));
  assert.deepEqual(mergeListening(b, a), log('dev', '2026-06-15', '1', 100, 200));
});

test('listening: merging is idempotent and commutative', () => {
  const a: ListeningLog = { devA: { '2026-06-15': { '1': { book: 100, wall: 120 } } } };
  const b: ListeningLog = { devB: { '2026-06-15': { '1': { book: 50, wall: 60 } }, '2026-06-14': { '2': { book: 5, wall: 5 } } } };
  const once = mergeListening(a, b);
  assert.deepEqual(mergeListening(once, a), once);
  assert.deepEqual(mergeListening(once, b), once);
  assert.deepEqual(mergeListening(a, b), mergeListening(b, a));
  assert.deepEqual(mergeListening(a, a), a);
});

test('listening: two devices on the same day add up in the stats', () => {
  const merged = mergeListening(log('phone', '2026-06-15', '1', 100, 120), log('tv', '2026-06-15', '1', 50, 60));
  const s = listeningStats(merged, {}, NOW);
  assert.equal(s.todayBook, 150);
  assert.equal(s.todayWall, 180);
});

test('listening: parse keeps good leaves and drops garbage', () => {
  const parsed = parseListening({
    good: { '2026-06-15': { '1': { book: 10, wall: 12 }, '2': { book: 'x', wall: 3 }, '3': { book: -5, wall: 5 }, '4': 'nope' } },
    badDay: { 'not-a-day': { '1': { book: 1, wall: 1 } } },
    notObject: 'nope',
    '': { '2026-06-15': { '1': { book: 1, wall: 1 } } },
  });
  assert.deepEqual(Object.keys(parsed), ['good']);
  assert.deepEqual(parsed.good['2026-06-15'], { '1': { book: 10, wall: 12 } });
  assert.deepEqual(parseListening(null), {});
  assert.deepEqual(parseListening('garbage'), {});
  assert.deepEqual(parseListening(42), {});
  assert.deepEqual(parseListening([]), {});
});

// ---- Stats ----

test('listening: totals for today, this week, this month, this year and all time', () => {
  // NOW is Monday 2026-06-15, so the week is 15–21 June.
  const data: ListeningLog = {
    dev: {
      '2026-06-15': { '1': { book: 100, wall: 120 } }, // today
      '2026-06-16': { '1': { book: 50, wall: 60 } }, // this week (Tue)
      '2026-06-03': { '2': { book: 20, wall: 20 } }, // this month, previous week
      '2026-03-01': { '2': { book: 30, wall: 30 } }, // this year, previous month
      '2025-12-31': { '3': { book: 40, wall: 40 } }, // last year
    },
  };
  const s = listeningStats(data, {}, NOW);
  assert.equal(s.todayBook, 100);
  assert.equal(s.todayWall, 120);
  assert.equal(s.weekBook, 150);
  assert.equal(s.weekWall, 180);
  assert.equal(s.monthBook, 170);
  assert.equal(s.monthWall, 200);
  assert.equal(s.yearBook, 200);
  assert.equal(s.yearWall, 230);
  assert.equal(s.allBook, 240);
  assert.equal(s.allWall, 270);
  assert.ok(Math.abs(s.averageSpeed - 240 / 270) < 1e-9);
});

test('listening: the last seven days end today and carry each day\u2019s book time', () => {
  const s = listeningStats(log('dev', '2026-06-15', '1', 10, 12), {}, NOW);
  assert.equal(s.last7.length, 7);
  assert.equal(s.last7[6].day, '2026-06-15');
  assert.equal(s.last7[6].book, 10);
  assert.equal(s.last7[0].day, '2026-06-09');
  assert.equal(s.last7[0].book, 0);
});

test('listening: a streak counts consecutive days with five minutes of wall time', () => {
  const m = STREAK_MIN_WALL;
  // Yesterday and the day before, but not today: the streak is unbroken (2).
  const throughYesterday: ListeningLog = {
    dev: {
      '2026-06-14': { '1': { book: m, wall: m } },
      '2026-06-13': { '1': { book: m, wall: m } },
    },
  };
  let s = listeningStats(throughYesterday, {}, NOW);
  assert.equal(s.currentStreak, 2);
  assert.equal(s.longestStreak, 2);

  // Today listened too: the run grows to 3.
  const withToday = mergeListening(throughYesterday, log('dev', '2026-06-15', '1', m, m));
  s = listeningStats(withToday, {}, NOW);
  assert.equal(s.currentStreak, 3);
  assert.equal(s.longestStreak, 3);

  // A gap breaks it; a longer past run is still the longest.
  const gap: ListeningLog = {
    dev: {
      '2026-06-15': { '1': { book: m, wall: m } },
      '2026-06-10': { '1': { book: m, wall: m } },
      '2026-06-09': { '1': { book: m, wall: m } },
      '2026-06-08': { '1': { book: m, wall: m } },
    },
  };
  s = listeningStats(gap, {}, NOW);
  assert.equal(s.currentStreak, 1);
  assert.equal(s.longestStreak, 3);

  // A silent day with under five minutes does not count.
  s = listeningStats(log('dev', '2026-06-15', '1', m - 1, m - 1), {}, NOW);
  assert.equal(s.currentStreak, 0);
});

test('listening: books finished this year, the top five and the average speed', () => {
  const books = {
    '1': { title: 'One', finishedAt: new Date(2026, 0, 10).getTime() },
    '2': { title: 'Two', finishedAt: new Date(2026, 4, 1).getTime() },
    '3': { title: 'Three', finishedAt: new Date(2025, 11, 1).getTime() },
  };
  const torrents: Record<string, { book: number; wall: number }> = {};
  for (let i = 1; i <= 6; i++) torrents[String(i)] = { book: i * 10, wall: i * 10 + i };
  const data: ListeningLog = { dev: { '2026-06-15': torrents } };
  const s = listeningStats(data, books, NOW);
  assert.equal(s.booksFinishedThisYear, 2);
  assert.equal(s.topBooks.length, 5);
  assert.deepEqual(s.topBooks.map((b) => b.torrentId), ['6', '5', '4', '3', '2']);
  assert.equal(s.topBooks[0].title, undefined); // book 6 has no metadata, only 1–3 do
  assert.equal(s.topBooks.find((b) => b.torrentId === '3')?.title, 'Three');
});

test('listening: formatListening reads as "12 h 40 min"', () => {
  assert.equal(formatListening(0), '0 min');
  assert.equal(formatListening(60), '1 min');
  assert.equal(formatListening(40 * 60), '40 min');
  assert.equal(formatListening(3 * 3600), '3 h');
  assert.equal(formatListening(12 * 3600 + 40 * 60), '12 h 40 min');
});

test('listening: formatListeningHours rounds a total that includes an estimate to the hour', () => {
  assert.equal(formatListeningHours(0), '0 h');
  assert.equal(formatListeningHours(60), 'under 1 h');
  assert.equal(formatListeningHours(46 * 3600 + 20 * 60), '46 h');
  assert.equal(formatListeningHours(12 * 3600 + 40 * 60), '13 h');
});

// ---- The sync document ----

test('listening: parseDoc reads the key, drops junk and an old document merges cleanly', () => {
  const parsed = parseDoc({ ...emptyDoc(), listening: { dev: { '2026-06-15': { '1': { book: 10, wall: 12 } } } } });
  assert.deepEqual(parsed.listening, { dev: { '2026-06-15': { '1': { book: 10, wall: 12 } } } });
  assert.deepEqual(parseDoc({ ...emptyDoc(), listening: 'garbage' }).listening, {});

  const old = emptyDoc() as any;
  delete old.listening; // as an Older app version wrote the document
  const oldParsed = parseDoc(old);
  assert.deepEqual(oldParsed.listening, {});
  const withData = { ...emptyDoc(), listening: { dev: { '2026-06-15': { '1': { book: 10, wall: 12 } } } } };
  assert.deepEqual(mergeDocs(withData, oldParsed).listening, withData.listening);
  assert.deepEqual(mergeDocs(oldParsed, withData).listening, withData.listening);
});

test('listening: mergeDocs adds two devices and is idempotent', () => {
  const a = { ...emptyDoc(), listening: log('phone', '2026-06-15', '1', 100, 120) };
  const b = { ...emptyDoc(), listening: log('tv', '2026-06-15', '1', 50, 60) };
  const once = mergeDocs(a, b);
  assert.deepEqual(Object.keys(once.listening).sort(), ['phone', 'tv']);
  assert.deepEqual(mergeDocs(once, b), once);
  assert.deepEqual(mergeDocs(once, a), once);
});

// ---- The one-time estimate of listening before tracking ----

test('estimate: the guessed bitrate table covers the common extensions', () => {
  assert.equal(guessedBitrate('book.mp3'), 64_000);
  assert.equal(guessedBitrate('book.M4B'), 64_000);
  assert.equal(guessedBitrate('book.m4a'), 64_000);
  assert.equal(guessedBitrate('book.aac'), 64_000);
  assert.equal(guessedBitrate('book.opus'), 48_000);
  assert.equal(guessedBitrate('book.ogg'), 48_000);
  assert.equal(guessedBitrate('book.flac'), DEFAULT_BITRATE_BPS);
  assert.equal(guessedBitrate('no-extension'), DEFAULT_BITRATE_BPS);
});

test('estimate: secondsFromBytes uses the guessed bitrate', () => {
  // 64 kbps = 8000 bytes/s, so an hour is 28.8 MB.
  assert.equal(secondsFromBytes(28_800_000, 'a.mp3'), 3600);
  // 48 kbps = 6000 bytes/s.
  assert.equal(secondsFromBytes(21_600_000, 'a.opus'), 3600);
  assert.equal(secondsFromBytes(0, 'a.mp3'), 0);
});

test('estimate: a finished book is its full length', () => {
  const prog = (over: Partial<EstimateProgress> = {}): EstimateProgress =>
    ({ fileId: 1, chapterIndex: 0, position: 0, duration: 0, updated: 100, ...over });
  // The current file's known duration wins.
  assert.equal(estimateBookSeconds({ torrentId: 1, files: [{ id: 1, name: 'a.m4b', size: 999 }], progress: prog({ duration: 3600, position: 3600, finished: true }) }), 3600);
  // A book marked finished with no duration falls back to the byte size.
  assert.equal(estimateBookSeconds({ torrentId: 1, files: [{ id: 1, name: 'a.mp3', size: 28_800_000 }], progress: prog({ finished: true }) }), 3600);
  // A finish date with no progress record still uses every file's size.
  assert.equal(estimateBookSeconds({ torrentId: 1, files: [{ id: 1, name: 'a.mp3', size: 28_800_000 }], finishedAt: 1 }), 3600);
  // A known duration (a read-along record) beats the byte size.
  assert.equal(estimateBookSeconds({ torrentId: 1, files: [{ id: 1, name: 'a.mp3', size: 0, duration: 1234 }], finishedAt: 1 }), 1234);
});

test('estimate: an unfinished book is the files before it plus the position', () => {
  const files = [
    { id: 1, name: 'a.mp3', size: 28_800_000 }, // 3600 s
    { id: 2, name: 'b.mp3', size: 28_800_000 }, // 3600 s
    { id: 3, name: 'c.mp3', size: 28_800_000 }, // 3600 s
  ];
  const progress = { fileId: 2, chapterIndex: 1, position: 1800, duration: 3600, updated: 100 };
  assert.equal(estimateBookSeconds({ torrentId: 1, files, progress }), 3600 + 1800);
  // The position is clamped to the current file's known duration.
  assert.equal(estimateBookSeconds({ torrentId: 1, files, progress: { ...progress, position: 9000 } }), 3600 + 3600);
  // The current file's known duration beats its byte size.
  assert.equal(estimateBookSeconds({
    torrentId: 1,
    files: [{ id: 1, name: 'a.mp3', size: 28_800_000 }],
    progress: { fileId: 1, chapterIndex: 0, position: 600, duration: 300, updated: 100 },
  }), 300);
  // A prior file's known duration (read-along record) beats its byte size, and a zero size is fine.
  assert.equal(estimateBookSeconds({
    torrentId: 1,
    files: [{ id: 1, name: 'a.mp3', size: 0, duration: 2000 }, { id: 2, name: 'b.mp3', size: 0 }],
    progress: { fileId: 2, chapterIndex: 1, position: 10, duration: 0, updated: 100 },
  }), 2010);
});

test('estimate: a needed length that is unknown yields null, so the snapshot can retry', () => {
  const files = [{ id: 1, name: 'a.mp3', size: 0 }, { id: 2, name: 'b.mp3', size: 28_800_000 }];
  assert.equal(estimateBookSeconds({ torrentId: 1, files, progress: { fileId: 2, chapterIndex: 1, position: 10, duration: 3600, updated: 1 } }), null);
  assert.equal(estimateBookSeconds({ torrentId: 1, files: [], progress: { fileId: 1, chapterIndex: 0, position: 10, duration: 0, updated: 1 } }), null);
});

test('estimate: buildListeningEstimate dates each book and bails on a missing length', () => {
  const files = [{ id: 1, name: 'a.mp3', size: 28_800_000 }];
  const est = buildListeningEstimate([
    { torrentId: 7, files, finishedAt: 5000 }, // finished -> at = finishedAt
    { torrentId: 8, files, progress: { fileId: 1, chapterIndex: 0, position: 600, duration: 0, updated: 9000 } }, // at = updated
    { torrentId: 9, files, progress: { fileId: 1, chapterIndex: 0, position: 0, duration: 0, updated: 1 } }, // nothing listened: skipped
  ], 1234);
  assert.equal(est?.createdAt, 1234);
  assert.deepEqual(Object.keys(est!.books).sort(), ['7', '8']);
  assert.equal(est!.books['7'].at, 5000);
  assert.equal(est!.books['7'].seconds, 3600);
  assert.equal(est!.books['8'].at, 9000);
  assert.equal(est!.books['8'].seconds, 600);
  // A book whose earlier file has no known length is left out; it must not block the others
  // (the current file's length is not needed: the position already covers it).
  assert.deepEqual(buildListeningEstimate([{
    torrentId: 1,
    files: [{ id: 1, name: 'a.mp3', size: 0 }, { id: 2, name: 'b.mp3', size: 28_800_000 }],
    progress: { fileId: 2, chapterIndex: 1, position: 5, duration: 0, updated: 1 },
  }], 1).books, {});
});

test('estimate: merge keeps the earliest createdAt, ties go to the larger total', () => {
  const est = (createdAt: number, books: Record<string, { seconds: number; at: number }>): ListeningEstimate => ({ createdAt, books });
  const earlier = est(100, { '1': { seconds: 10, at: 1 } });
  const later = est(200, { '2': { seconds: 9999, at: 2 } });
  assert.equal(mergeListeningEstimates(earlier, later), earlier);
  assert.equal(mergeListeningEstimates(later, earlier), earlier);
  assert.equal(mergeListeningEstimates(null, later), later);
  assert.equal(mergeListeningEstimates(earlier, null), earlier);
  assert.equal(mergeListeningEstimates(null, null), null);
  // Same time: the larger total wins, both ways, and re-merging is stable.
  const small = est(100, { '1': { seconds: 10, at: 1 } });
  const big = est(100, { '1': { seconds: 50, at: 1 } });
  assert.equal(mergeListeningEstimates(small, big), big);
  assert.equal(mergeListeningEstimates(big, small), big);
  const once = mergeListeningEstimates(small, big);
  assert.deepEqual(mergeListeningEstimates(once, big), once);
});

test('estimate: a history snapshot beats a progress-only one, whatever the time', () => {
  const progress: ListeningEstimate = { createdAt: 1, books: { '1': { seconds: 100, at: 5 } }, days: {}, source: 'progress' };
  const history: ListeningEstimate = { createdAt: 999, books: {}, days: { '2026-06-15': { '1': 100 } }, source: 'history' };
  assert.equal(mergeListeningEstimates(progress, history), history);
  assert.equal(mergeListeningEstimates(history, progress), history);
  // Two history snapshots still go by the earliest createdAt.
  const older = { ...history, createdAt: 10 };
  assert.equal(mergeListeningEstimates(history, older), older);
});

test('estimate: parse keeps a snapshot, drops junk and reads a missing key as null', () => {
  assert.deepEqual(parseListeningEstimate(null), null);
  assert.deepEqual(parseListeningEstimate('nope'), null);
  assert.deepEqual(parseListeningEstimate({ books: {} }), null); // no createdAt
  const kept = parseListeningEstimate({ createdAt: 5, books: {
    good: { seconds: 10, at: 20 },
    noAt: { seconds: 10 },
    badSeconds: { seconds: -1, at: 20 },
    junk: 3,
  } });
  assert.deepEqual(kept, { createdAt: 5, books: { good: { seconds: 10, at: 20 } }, days: {}, source: 'progress' });
  assert.deepEqual(parseDoc({ ...emptyDoc() }).listeningEstimate, null);
});

test('estimate: parse reads dated days and the source, dropping junk days', () => {
  const kept = parseListeningEstimate({ createdAt: 5, source: 'history', books: {}, days: {
    '2026-06-15': { '1': 100, bad: -1 },
    junk: { '1': 5 },
    empty: {},
  } });
  assert.deepEqual(kept, { createdAt: 5, books: {}, days: { '2026-06-15': { '1': 100 } }, source: 'history' });
});

test('estimate: mergeDocs takes the earlier snapshot across devices', () => {
  const a = { ...emptyDoc(), listeningEstimate: { createdAt: 100, books: { '1': { seconds: 10, at: 1 } } } };
  const b = { ...emptyDoc(), listeningEstimate: { createdAt: 200, books: { '2': { seconds: 20, at: 2 } } } };
  assert.equal(mergeDocs(a, b).listeningEstimate?.createdAt, 100);
  assert.equal(mergeDocs(b, a).listeningEstimate?.createdAt, 100);
  assert.deepEqual(mergeDocs(a, b), mergeDocs(b, a));
});

// ---- Reconstruction from the gist revision history ----

const rev = (at: string, progress: Record<string, RevisionProgress>): ListeningRevision => ({ at: Date.parse(at), progress });
const oneFile = (seconds: number): Record<string, EstimateFile[]> => ({ '1': [{ id: 1, name: 'book.m4b', size: 0, duration: seconds }] });
const at = (position: number, finished = false): RevisionProgress => ({ fileId: 1, chapterIndex: 0, position, duration: 0, finished });

test('history: the Dune case dates the old and recent listening to their own days', () => {
  const H = 3600;
  const files = oneFile(20 * H);
  const revisions = [
    rev('2026-03-11T12:00:00', { '1': at(4 * H) }),
    rev('2026-03-12T12:00:00', { '1': at(7 * H) }),
    rev('2026-03-13T12:00:00', { '1': at(10 * H) }), // 10 h over three days, ~100 days ago
    rev('2026-06-15T12:00:00', { '1': at(12 * H) }),
    rev('2026-06-16T12:00:00', { '1': at(14 * H) }),
    rev('2026-06-17T12:00:00', { '1': at(16 * H) }),
    rev('2026-06-18T12:00:00', { '1': at(18 * H) }),
    rev('2026-06-19T12:00:00', { '1': at(20 * H) }), // 10 h more over five days last week
  ];
  const history = reconstructHistory(revisions, files);
  assert.equal(history.secondsByTorrent['1'], 20 * H);
  assert.equal(history.days['2026-03-11']['1'], 4 * H);
  assert.equal(history.days['2026-03-12']['1'], 3 * H);
  assert.equal(history.days['2026-03-13']['1'], 3 * H);
  assert.equal(history.days['2026-06-19']['1'], 2 * H);

  const now = new Date(2026, 5, 21, 12).getTime(); // Sunday; the Mon–Sun week is 15–21 June
  const entries = [{ torrentId: 1, files: files['1'], progress: { fileId: 1, chapterIndex: 0, position: 20 * H, duration: 20 * H, updated: now } }];
  const est = buildHistoryEstimate(history, entries, now);
  assert.equal(est.source, 'history');
  assert.deepEqual(est.books, {}); // the 20 h are fully covered by history

  const s = listeningStats({}, {}, now, est);
  assert.equal(s.weekBook, 10 * H);
  assert.equal(s.yearBook, 20 * H);
  assert.equal(s.allBook, 20 * H);
  assert.equal(s.estWeek, 10 * H);
  assert.equal(s.estYear, 20 * H);
  // The recent days fill the 7-day bars as estimates; the March days stay off them.
  const bars = Object.fromEntries(s.last7.map((d) => [d.day, d.estBook]));
  assert.equal(bars['2026-06-15'], 2 * H);
  assert.equal(bars['2026-06-19'], 2 * H);
  assert.equal(bars['2026-06-20'], 0);
  assert.equal(s.last7.filter((d) => d.estBook > 0).length, 5);
  // An estimate never touches the walls, streaks or speed.
  assert.equal(s.weekWall, 0);
  assert.equal(s.averageSpeed, 0);
  assert.equal(s.currentStreak, 0);
});

test('history: only the last revision of each day counts', () => {
  const files = oneFile(10 * 3600);
  const history = reconstructHistory([
    rev('2026-06-15T09:00:00', { '1': at(8 * 3600) }), // earlier that day
    rev('2026-06-15T20:00:00', { '1': at(5 * 3600) }), // the day's last revision (a seek back)
  ], files);
  assert.deepEqual(history.days['2026-06-15'], { '1': 5 * 3600 });
});

test('history: a backward move adds nothing', () => {
  const files = oneFile(10 * 3600);
  const history = reconstructHistory([
    rev('2026-06-15T12:00:00', { '1': at(5 * 3600) }),
    rev('2026-06-16T12:00:00', { '1': at(3 * 3600) }),
  ], files);
  assert.equal(history.secondsByTorrent['1'], 5 * 3600);
  assert.equal(history.days['2026-06-16'], undefined);
});

test('history: a single book-day is capped at 16 h', () => {
  const files = oneFile(40 * 3600);
  const day1 = rev('2026-06-14T12:00:00', { '1': at(3600) });
  const capped = reconstructHistory([day1, rev('2026-06-15T12:00:00', { '1': at(21 * 3600) })], files);
  assert.equal(capped.days['2026-06-15']['1'], HISTORY_DAY_CAP);
  // Under the cap it is kept as is.
  const under = reconstructHistory([day1, rev('2026-06-15T12:00:00', { '1': at(16 * 3600) })], files);
  assert.equal(under.days['2026-06-15']['1'], 15 * 3600);
  // The first sighting is everything listened before sync existed, so it is never capped.
  const first = reconstructHistory([rev('2026-06-15T12:00:00', { '1': at(20 * 3600) })], files);
  assert.equal(first.days['2026-06-15']['1'], 20 * 3600);
});

test('history: a book in progress before the first revision counts its whole position then', () => {
  const files = oneFile(10 * 3600);
  const history = reconstructHistory([rev('2026-06-15T12:00:00', { '1': at(4 * 3600) })], files);
  assert.deepEqual(history.days['2026-06-15'], { '1': 4 * 3600 });
});

test('history: a book finished between revisions counts up to its full length', () => {
  const files = oneFile(10 * 3600);
  const history = reconstructHistory([
    rev('2026-06-15T12:00:00', { '1': at(6 * 3600) }),
    rev('2026-06-16T12:00:00', { '1': at(0, true) }), // finished: the whole 10 h
  ], files);
  assert.equal(history.days['2026-06-15']['1'], 6 * 3600);
  assert.equal(history.days['2026-06-16']['1'], 4 * 3600);
});

test('history: a remainder the history did not cover stays a lump dated now', () => {
  const files = oneFile(20 * 3600);
  const history = reconstructHistory([rev('2026-06-15T12:00:00', { '1': at(5 * 3600) })], files);
  const now = new Date(2026, 5, 20, 12).getTime();
  const entries = [{ torrentId: 1, files: files['1'], progress: { fileId: 1, chapterIndex: 0, position: 20 * 3600, duration: 20 * 3600, updated: now } }];
  const est = buildHistoryEstimate(history, entries, now);
  assert.equal(est.books['1'].seconds, 15 * 3600);
  assert.equal(est.books['1'].at, now);
  assert.equal(est.days['2026-06-15']['1'], 5 * 3600);
});

test('stats: estimate seconds add to book totals and top books but not walls, bars or speed', () => {
  // A Thursday, so the Mon–Sun week and the last seven days both hold past days.
  const now = new Date(2026, 5, 18, 12, 0, 0).getTime();
  const live = log('dev', '2026-06-18', '1', 3600, 3600); // 1 h live today, 1x
  const estimate: ListeningEstimate = { createdAt: 1, books: {
    '9': { seconds: 7200, at: new Date(2026, 5, 17, 12).getTime() }, // yesterday: this week/month/year
    '8': { seconds: 3600, at: new Date(2025, 11, 31, 12).getTime() }, // last year
  } };
  const s = listeningStats(live, { '9': { title: 'Estimated' } }, now, estimate);
  assert.equal(s.todayBook, 3600); // the estimate is not today
  assert.equal(s.weekBook, 3600 + 7200);
  assert.equal(s.monthBook, 3600 + 7200);
  assert.equal(s.yearBook, 3600 + 7200);
  assert.equal(s.allBook, 3600 + 7200 + 3600);
  // Wall time and everything derived from it never see the estimate.
  assert.equal(s.todayWall, 3600);
  assert.equal(s.allWall, 3600);
  assert.equal(s.averageSpeed, 1);
  assert.deepEqual(s.last7.map((d) => d.book), [0, 0, 0, 0, 0, 0, 3600]); // the estimate day stays empty
  // The estimate day (yesterday) must not extend the streak: only today counts.
  assert.equal(s.currentStreak, 1);
  assert.equal(s.longestStreak, 1);
  // Top books this year include the estimated one.
  assert.deepEqual(s.topBooks.map((b) => b.torrentId).sort(), ['1', '9']);
  assert.equal(s.topBooks.find((b) => b.torrentId === '9')?.estimated, true);
  assert.equal(s.topBooks.find((b) => b.torrentId === '1')?.estimated, false);
  // The per-period estimate fields let the screen say where it came from.
  assert.equal(s.estToday, 0);
  assert.equal(s.estWeek, 7200);
  assert.equal(s.estYear, 7200);
  assert.equal(s.estAll, 10800);
});

test('stats: dated days and undated lumps both count in the periods, only days on the bars', () => {
  const now = new Date(2026, 5, 21, 12).getTime(); // Sunday, week 15–21 June
  const estimate: ListeningEstimate = {
    createdAt: 1,
    source: 'history',
    books: { '9': { seconds: 3 * 3600, at: now } }, // lump -> today, this week
    days: { '2026-06-16': { '8': 2 * 3600 } }, // Tuesday -> this week, not today
  };
  const s = listeningStats({}, {}, now, estimate);
  assert.equal(s.estWeek, 5 * 3600);
  assert.equal(s.estToday, 3 * 3600);
  assert.equal(s.estAll, 5 * 3600);
  assert.equal(s.weekBook, 5 * 3600);
  const bars = Object.fromEntries(s.last7.map((d) => [d.day, d.estBook]));
  assert.equal(bars['2026-06-16'], 2 * 3600);
  assert.equal(bars['2026-06-21'], 0); // the lump is never on a bar
  // The dated day still ranks its book in the top list.
  assert.equal(s.topBooks.find((b) => b.torrentId === '8')?.estimated, true);
});

