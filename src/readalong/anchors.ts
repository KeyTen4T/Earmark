// Read-along tokeniser and time -> paragraph lookup. Pure: no react-native, expo, node APIs or
// DOMParser. Ports `normalize_words` from tools/readalong/readalong.py and adds the compact synced
// record plus an interpolating `locate`.

import { decodeSeekMap, type XingSeekMap } from './mp3seek';

// Curly quotes, dashes and spaces folded before tokenising (readalong.py's _FOLD).
const FOLD: Record<number, string> = {
  0x2018: "'", 0x2019: "'", 0x201a: "'", 0x201b: "'",
  0x201c: '"', 0x201d: '"', 0x201e: '"', 0x201f: '"',
  0x2010: '-', 0x2011: '-', 0x2012: '-', 0x2013: '-', 0x2014: '-', 0x2015: '-',
  0x2026: ' ', 0x00a0: ' ', 0x202f: ' ', 0x2009: ' ',
};

// Python's r"[^\W_]+" (Unicode letters + numbers, underscore and punctuation dropped).
const WORD_RE = /[\p{L}\p{N}]+/gu;

function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    out += FOLD[code] ?? ch;
  }
  return out;
}

/** Lowercase, NFKC, fold quotes/dashes, strip punctuation, keep numbers. Mirrors `normalize_words`. */
export function normalizeWords(text: string | null | undefined): string[] {
  if (!text) return [];
  const normalized = typeof text.normalize === 'function' ? text.normalize('NFKC') : text;
  const folded = fold(normalized).toLowerCase();
  return folded.match(WORD_RE) ?? [];
}

// --------------------------------------------------------------------------------------
// Synced record types
// --------------------------------------------------------------------------------------

/** One anchor: [time in seconds, paragraph index, global word index]. */
export type ReadalongAnchor = [t: number, para: number, word: number];

export type ReadalongFile = {
  id: number;
  duration: number;
  anchors: ReadalongAnchor[];
  /** Xing/VBR seek map, present only for a single Xing MP3; see src/readalong/mp3seek.ts. */
  seek?: XingSeekMap;
};

export type ReadalongRecord = {
  epub: { hash: string; fileId: number; title: string; paragraphs: number; paragraphsSha1: string };
  files: ReadalongFile[];
  /**
   * 2 when the record was built from word-timed (version-2) anchors. Records without it were built
   * from v1 anchors whose `t` is the clip midpoint, about 10 s late; `withTimingCorrection` shifts
   * those in memory when they are read.
   */
  timing?: number;
  created: number; // ms epoch
};

/** The subset of the tool's anchors.json we consume. */
export type AnchorsJson = {
  version?: number;
  timing?: string;
  hash?: string;
  epub?: { title?: string; paragraphs?: number; words?: number; source?: string; paragraphsSha1?: string };
  files?: {
    id?: number;
    name?: string;
    duration?: number | null;
    anchors?: { t?: number; para?: number; word?: number; conf?: number }[];
    /** A Xing seek map; validated and copied through when present. */
    seek?: unknown;
  }[];
};

/**
 * Converts the tool's anchors.json into a compact record. Malformed files/anchors are dropped
 * rather than throwing, so a partial or hand-edited file still yields something usable.
 */
export function fromAnchorsJson(
  anchorsJson: AnchorsJson,
  epub: { hash: string; fileId: number },
  created = Date.now(),
): ReadalongRecord {
  const files: ReadalongFile[] = [];
  for (const f of anchorsJson.files ?? []) {
    if (!f || typeof f.id !== 'number') continue;
    const anchors: ReadalongAnchor[] = [];
    for (const a of f.anchors ?? []) {
      if (!a || typeof a.t !== 'number' || typeof a.para !== 'number' || typeof a.word !== 'number') continue;
      anchors.push([a.t, a.para, a.word]);
    }
    anchors.sort((x, y) => x[0] - y[0]);
    const seek = decodeSeekMap(f.seek);
    files.push({
      id: f.id,
      duration: typeof f.duration === 'number' ? f.duration : 0,
      anchors,
      ...(seek ? { seek } : {}),
    });
  }
  const wordTimed = anchorsJson.timing === 'word'
    || (typeof anchorsJson.version === 'number' && anchorsJson.version >= 2);
  return {
    epub: {
      hash: epub.hash,
      fileId: epub.fileId,
      title: anchorsJson.epub?.title ?? '',
      paragraphs: anchorsJson.epub?.paragraphs ?? 0,
      paragraphsSha1: anchorsJson.epub?.paragraphsSha1 ?? '',
    },
    files,
    ...(wordTimed ? { timing: 2 } : {}),
    created,
  };
}

/** v1 anchors paired a clip's start word with the clip midpoint; the lag is about 10 s. */
export const LEGACY_ANCHOR_LAG_SECONDS = 10;

/**
 * Returns the record with legacy anchor times corrected.
 *
 * Records built from version-2 (word-timed) anchors carry `timing: 2` and are returned unchanged.
 * Older records lag by about 10 s, so every anchor time gets 10 s subtracted (clamped at 0) and the
 * times are kept strictly increasing. The stored record is never rewritten; this is a read-time
 * view used by both `locate` and `timeForWord`.
 */
export function withTimingCorrection(record: ReadalongRecord): ReadalongRecord {
  if (record.timing === 2) return record;
  const files = record.files.map((f) => {
    let prev = Number.NEGATIVE_INFINITY;
    const anchors = f.anchors
      .slice()
      .sort((a, b) => a[0] - b[0])
      .map(([t, para, word]): ReadalongAnchor => {
        let nt = Math.max(0, t - LEGACY_ANCHOR_LAG_SECONDS);
        if (nt <= prev) nt = prev + 0.001; // two anchors clamped to 0 must stay strictly increasing
        prev = nt;
        return [nt, para, word];
      });
    return { ...f, anchors };
  });
  return { ...record, files };
}

/** Word -> paragraph map for a paragraph list, using the same tokeniser as the tool. */
export function buildWordIndex(paragraphs: string[]): Int32Array {
  const out: number[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const n = normalizeWords(paragraphs[i]).length;
    for (let j = 0; j < n; j++) out.push(i);
  }
  return Int32Array.from(out);
}

/** Median words/sec over a file's consecutive anchors (0 when there are fewer than two). */
function medianPace(anchors: ReadalongAnchor[]): number {
  const rates: number[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const dt = anchors[i][0] - anchors[i - 1][0];
    if (dt > 0) rates.push((anchors[i][2] - anchors[i - 1][2]) / dt);
  }
  if (!rates.length) return 0;
  rates.sort((a, b) => a - b);
  const mid = rates.length >> 1;
  return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
}

/**
 * Locate the paragraph playing at `seconds` for `fileId`. Linearly interpolates the global word
 * index between the surrounding anchors, and outside the first/last anchor extrapolates at the
 * file's median pace (clamped to the neighbouring anchor and to the book). Maps word -> paragraph
 * via `wordToPara`. Returns null if the file is absent or has no anchors.
 */
export function locate(
  record: ReadalongRecord,
  wordToPara: Int32Array | number[],
  fileId: number,
  seconds: number,
): { para: number; word: number } | null {
  const rec = withTimingCorrection(record);
  const file = rec.files.find((f) => f.id === fileId);
  if (!file || !file.anchors.length) return null;
  if (!wordToPara.length) return null;

  const anchors = file.anchors.slice().sort((a, b) => a[0] - b[0]);
  const first = anchors[0];
  const last = anchors[anchors.length - 1];

  const map = (raw: number): { para: number; word: number } => {
    let word = Math.round(raw);
    if (word < 0) word = 0;
    if (word >= wordToPara.length) word = wordToPara.length - 1;
    return { para: wordToPara[word], word };
  };

  if (seconds <= first[0]) {
    const pace = medianPace(anchors);
    const word = Math.min(first[2] - pace * (first[0] - seconds), first[2]); // never past the first anchor
    return map(word);
  }
  if (seconds >= last[0]) {
    const pace = medianPace(anchors);
    const word = Math.max(last[2] + pace * (seconds - last[0]), last[2]); // never past the last anchor
    return map(word);
  }

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (seconds >= a[0] && seconds <= b[0]) {
      const dt = b[0] - a[0];
      const frac = dt > 0 ? (seconds - a[0]) / dt : 0;
      return map(a[2] + (b[2] - a[2]) * frac);
    }
  }
  return map(last[2]);
}

/**
 * The inverse of `locate`: the playback time (seconds) at which `word` is read in `fileId`.
 * Linearly interpolates between the anchors around that word; before the first / after the last
 * anchor it extrapolates at the file's median pace. The result is clamped to [0, duration].
 * Returns null if the file is absent or has no anchors. A word that no anchor ever brackets (or a
 * file whose pace is unknown) lands on the nearest anchor's time rather than throwing.
 */
export function timeForWord(record: ReadalongRecord, fileId: number, word: number): number | null {
  const rec = withTimingCorrection(record);
  const file = rec.files.find((f) => f.id === fileId);
  if (!file || !file.anchors.length) return null;

  const anchors = file.anchors.slice().sort((a, b) => a[0] - b[0]);
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const hi = file.duration > 0 ? file.duration : Number.POSITIVE_INFINITY;
  const clamp = (t: number) => Math.max(0, Math.min(hi, t));
  const pace = medianPace(anchors);

  // Outside the anchors, undo locate()'s median-pace extrapolation.
  if (word <= first[2]) {
    if (pace <= 0) return clamp(first[0]);
    return clamp(first[0] - (first[2] - word) / pace);
  }
  if (word >= last[2]) {
    if (pace <= 0) return clamp(last[0]);
    return clamp(last[0] + (word - last[2]) / pace);
  }

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (word >= a[2] && word <= b[2]) {
      const dw = b[2] - a[2];
      if (dw <= 0) return clamp(a[0]);
      return clamp(a[0] + (b[0] - a[0]) * ((word - a[2]) / dw));
    }
  }
  return clamp(last[0]);
}

/**
 * The global index of the first word of paragraph `para`, found in the (non-decreasing) word ->
 * paragraph map. Returns `wordToPara.length` when the paragraph has no words (e.g. it was empty).
 */
export function paragraphStartWord(wordToPara: Int32Array | number[], para: number): number {
  let lo = 0;
  let hi = wordToPara.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (wordToPara[mid] < para) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
