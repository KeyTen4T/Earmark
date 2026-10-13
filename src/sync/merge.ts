// The pure half of cross-device sync: the shape of the sync document, tolerant parsing, and a
// per-record last-write-wins merge. Deliberately free of React Native, Expo and fetch imports so
// it runs under the plain Node test runner (test/sync.test.ts).

import type { ReadalongRecord } from '../readalong/anchors';
import { decodeSeekMap } from '../readalong/mp3seek';

export const SYNC_VERSION = 1;

export type ProgressRecord = {
  fileId: number;
  chapterIndex: number;
  chapterCount: number;
  position: number;
  duration: number;
  updated: number;
  finished?: boolean;
};

export type MetaFields = { title?: string; author?: string; narrator?: string; cover?: string; finishedAt?: number; rating?: number };

/** Mirrors CatalogBook in ../catalog; repeated here so merge stays dependency-free. */
export type CatalogBook = {
  id: string;
  title: string;
  author?: string;
  cover?: string;
  description?: string;
  genre?: string;
  year?: string;
  price?: string;
  url?: string;
  previewUrl?: string;
};

export type SettingsFields = { rate: number; skipBack: number; skipForward: number };

/**
 * The read-along builder's EPUB search address, a single stamped string. `''` is a real value (the
 * user cleared it), distinct from "never set", which carries stamp 0 and so loses to anything real.
 * It is a top-level key on purpose: older versions normalise `settings` to exactly its three fields
 * and would drop a field hidden inside it, but they carry unknown top-level keys through untouched.
 */
export type EbookSearch = { value: string; updated: number };

/** One synced record. `value: null` is a tombstone: the record was deleted on some device. */
export type Stamped<T> = { value: T | null; updated: number };

export type SyncDoc = {
  v: number;
  progress: Record<string, ProgressRecord>;
  meta: Record<string, Stamped<MetaFields>>;
  hidden: Record<string, Stamped<boolean>>;
  wishlist: Record<string, Stamped<CatalogBook>>;
  settings: Stamped<SettingsFields>;
  ebookSearch: EbookSearch;
  readalong: Record<string, Stamped<ReadalongRecord>>;
  [key: string]: unknown;
};

export function emptyDoc(): SyncDoc {
  return {
    v: SYNC_VERSION, progress: {}, meta: {}, hidden: {}, wishlist: {},
    settings: { value: null, updated: 0 }, ebookSearch: { value: '', updated: 0 }, readalong: {},
  };
}

export function isTooNew(doc: SyncDoc): boolean {
  return (doc.v || 0) > SYNC_VERSION;
}

/** Deterministic JSON, with object keys sorted, for equality checks and tie-breaks. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  // Match JSON.stringify by dropping undefined-valued keys, so an explicit `undefined` and a missing
  // field compare equal and don't cause a spurious rewrite on every sync.
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown, fallback = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

function metaFields(v: Record<string, unknown>): MetaFields {
  const out: MetaFields = {};
  if (typeof v.title === 'string') out.title = v.title;
  if (typeof v.author === 'string') out.author = v.author;
  if (typeof v.narrator === 'string') out.narrator = v.narrator;
  if (typeof v.cover === 'string') out.cover = v.cover;
  if (typeof v.finishedAt === 'number' && Number.isFinite(v.finishedAt) && v.finishedAt > 0) out.finishedAt = v.finishedAt;
  if (typeof v.rating === 'number' && Number.isFinite(v.rating)) out.rating = v.rating;
  return out;
}

/** Validates a read-along record's shape; returns null (dropped) when it is malformed. */
function readalongRecord(v: Record<string, unknown>): ReadalongRecord | null {
  if (!isObj(v.epub) || !Array.isArray(v.files)) return null;
  const e = v.epub;
  if (typeof e.hash !== 'string' || typeof e.paragraphsSha1 !== 'string') return null;
  if (typeof e.fileId !== 'number' || typeof e.paragraphs !== 'number') return null;
  const files: ReadalongRecord['files'] = [];
  for (const f of v.files) {
    if (!isObj(f) || typeof f.id !== 'number' || typeof f.duration !== 'number' || !Array.isArray(f.anchors)) return null;
    const anchors: ReadalongRecord['files'][number]['anchors'] = [];
    for (const a of f.anchors) {
      if (!Array.isArray(a) || a.length < 3) return null;
      if (typeof a[0] !== 'number' || typeof a[1] !== 'number' || typeof a[2] !== 'number') return null;
      anchors.push([a[0], a[1], a[2]]);
    }
    const seek = decodeSeekMap(f.seek);
    files.push({ id: f.id, duration: f.duration, anchors, ...(seek ? { seek } : {}) });
  }
  return {
    epub: {
      hash: e.hash,
      fileId: e.fileId,
      title: typeof e.title === 'string' ? e.title : '',
      paragraphs: e.paragraphs,
      paragraphsSha1: e.paragraphsSha1,
    },
    files,
    // Word-timed (v2) records carry `timing: 2`; anything else is left unmarked so it is corrected
    // at read time. Unknown/absent values are simply dropped, so older apps don't choke.
    ...(v.timing === 2 ? { timing: 2 } : {}),
    created: num(v.created),
  };
}

/**
 * Reads whatever a gist holds into a well-formed document. Unknown top-level keys are kept, and a
 * malformed record is dropped rather than throwing, so a hand-edited or future file can't crash us.
 */
export function parseDoc(raw: unknown): SyncDoc {
  const doc = emptyDoc();
  if (!isObj(raw)) return doc;
  doc.v = num(raw.v, SYNC_VERSION);

  if (isObj(raw.progress)) {
    for (const [key, val] of Object.entries(raw.progress)) {
      if (!isObj(val)) continue;
      const rec: ProgressRecord = {
        fileId: num(val.fileId), chapterIndex: num(val.chapterIndex), chapterCount: num(val.chapterCount),
        position: num(val.position), duration: num(val.duration), updated: num(val.updated),
      };
      if (typeof val.finished === 'boolean') rec.finished = val.finished;
      doc.progress[key] = rec;
    }
  }
  if (isObj(raw.meta)) {
    for (const [key, val] of Object.entries(raw.meta)) {
      if (!isObj(val)) continue;
      doc.meta[key.toLowerCase()] = {
        value: isObj(val.value) ? metaFields(val.value) : null,
        updated: num(val.updated),
      };
    }
  }
  if (isObj(raw.hidden)) {
    for (const [key, val] of Object.entries(raw.hidden)) {
      if (!isObj(val)) continue;
      doc.hidden[key.toLowerCase()] = { value: val.value === true, updated: num(val.updated) };
    }
  }
  if (isObj(raw.wishlist)) {
    for (const [key, val] of Object.entries(raw.wishlist)) {
      if (!isObj(val)) continue;
      doc.wishlist[key] = { value: isObj(val.value) ? (val.value as unknown as CatalogBook) : null, updated: num(val.updated) };
    }
  }
  if (isObj(raw.settings)) {
    const sv = isObj(raw.settings.value) ? raw.settings.value : null;
    doc.settings = {
      value: sv ? { rate: num(sv.rate, 1), skipBack: num(sv.skipBack, 15), skipForward: num(sv.skipForward, 30) } : null,
      updated: num(raw.settings.updated),
    };
  }
  // A missing or malformed key (an older document, or junk) keeps the never-set default: value '' and
  // stamp 0, which loses to any real value.
  if (isObj(raw.ebookSearch) && typeof raw.ebookSearch.value === 'string') {
    doc.ebookSearch = { value: raw.ebookSearch.value, updated: num(raw.ebookSearch.updated) };
  }
  if (isObj(raw.readalong)) {
    for (const [key, val] of Object.entries(raw.readalong)) {
      if (!isObj(val)) continue;
      const k = key.toLowerCase();
      if (val.value === null) { doc.readalong[k] = { value: null, updated: num(val.updated) }; continue; }
      const rec = isObj(val.value) ? readalongRecord(val.value) : null;
      if (!rec) continue; // malformed record: drop rather than throw
      doc.readalong[k] = { value: rec, updated: num(val.updated) };
    }
  }
  for (const key of Object.keys(raw)) if (!(key in doc)) doc[key] = raw[key];
  return doc;
}

function newerStamped<T>(a: Stamped<T>, b: Stamped<T>): Stamped<T> {
  if (a.updated !== b.updated) return a.updated > b.updated ? a : b;
  // Equal times: pick deterministically so the merge is commutative regardless of argument order.
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

/** Like newerStamped, but the value is always a string (no tombstone: clearing is `''`). */
function newerEbookSearch(a: EbookSearch, b: EbookSearch): EbookSearch {
  if (a.updated !== b.updated) return a.updated > b.updated ? a : b;
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

function mergeStamped<T>(a: Record<string, Stamped<T>>, b: Record<string, Stamped<T>>): Record<string, Stamped<T>> {
  const out: Record<string, Stamped<T>> = {};
  for (const key of Object.keys(a)) out[key] = a[key];
  for (const key of Object.keys(b)) out[key] = key in out ? newerStamped(out[key], b[key]) : b[key];
  return out;
}

function newerProgress(a: ProgressRecord, b: ProgressRecord): ProgressRecord {
  if ((a.updated || 0) !== (b.updated || 0)) return (a.updated || 0) > (b.updated || 0) ? a : b;
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

function mergeProgress(a: Record<string, ProgressRecord>, b: Record<string, ProgressRecord>): Record<string, ProgressRecord> {
  const out: Record<string, ProgressRecord> = { ...a };
  for (const key of Object.keys(b)) out[key] = key in out ? newerProgress(out[key], b[key]) : b[key];
  return out;
}

const KNOWN = new Set(['v', 'progress', 'meta', 'hidden', 'wishlist', 'settings', 'ebookSearch', 'readalong']);

/** Per-record last-write-wins merge. Idempotent and commutative. */
export function mergeDocs(a: SyncDoc, b: SyncDoc): SyncDoc {
  const out = emptyDoc();
  out.v = Math.max(a.v || 0, b.v || 0) || SYNC_VERSION;
  out.progress = mergeProgress(a.progress, b.progress);
  out.meta = mergeStamped(a.meta, b.meta);
  out.hidden = mergeStamped(a.hidden, b.hidden);
  out.wishlist = mergeStamped(a.wishlist, b.wishlist);
  out.settings = newerStamped(a.settings, b.settings);
  out.ebookSearch = newerEbookSearch(a.ebookSearch, b.ebookSearch);
  out.readalong = mergeStamped(a.readalong, b.readalong);

  // Unknown top-level keys (a future version may add some) are preserved with a deterministic pick.
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (KNOWN.has(key)) continue;
    const av = (a as Record<string, unknown>)[key];
    const bv = (b as Record<string, unknown>)[key];
    out[key] = key in a && key in b ? (stableStringify(av) >= stableStringify(bv) ? av : bv) : key in a ? av : bv;
  }
  return out;
}

export function docEquals(a: SyncDoc, b: SyncDoc): boolean {
  return stableStringify(a) === stableStringify(b);
}
