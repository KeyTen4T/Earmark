// Chapters that live inside one audio file: the Nero `chpl` atom or a QuickTime chapter text track
// in MP4/M4B/M4A, and ID3v2 CHAP frames in MP3. A one-file audiobook otherwise shows a single
// "Chapter 1 of 1", so these give it a real chapter list without changing the file-based players.
//
// Pure: bytes arrive through an injected `readRange`, so the Node test runner feeds byte fixtures
// and the app feeds HTTP ranges (src/chapters/fetch). No react-native/expo imports. A malformed or
// unsupported file returns null rather than throwing, and the caller leaves everything as it was.

/** One chapter found inside a file. `start` is seconds from the beginning of that file. */
export type EmbeddedChapter = { title: string; start: number };

/** Reads the bytes of [start, endInclusive]; may return fewer at the end of the file. */
export type ReadRange = (start: number, endInclusive: number) => Promise<Uint8Array>;

const MAX_MOOV = 16 * 1024 * 1024;
const MAX_ID3_TAG = 2 * 1024 * 1024;
const MAX_CHAPTERS = 2000;
const MAX_TABLE_ENTRIES = 1_000_000;

// ---- Small byte helpers ----------------------------------------------------------------

const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const be32 = (b: Uint8Array, at: number) => (((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0);
const be64 = (b: Uint8Array, at: number) => be32(b, at) * 4294967296 + be32(b, at + 4);
const syncsafe = (b: Uint8Array, at: number) =>
  ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);
const str4 = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const isFrameId = (s: string) => /^[A-Z0-9]{4}$/.test(s);

function latin1(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]);
  return out;
}

// Hermes (React Native) may lack TextDecoder, so UTF-8 is decoded by hand.
function utf8Decode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    let cp = c;
    if (c >= 0xf0) cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else if (c >= 0xe0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else if (c >= 0xc0) cp = ((c & 31) << 6) | (b[i++] & 63);
    out += String.fromCodePoint(cp);
  }
  return out;
}

function utf16Decode(b: Uint8Array, littleEndian: boolean): string {
  let out = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    out += String.fromCharCode(littleEndian ? b[i] | (b[i + 1] << 8) : be16(b, i));
  }
  return out;
}

const hasBomLE = (b: Uint8Array) => b.length >= 2 && b[0] === 0xff && b[1] === 0xfe;
const hasBomBE = (b: Uint8Array) => b.length >= 2 && b[0] === 0xfe && b[1] === 0xff;

/** ID3 text encodings 0 (Latin-1), 1 (UTF-16 with BOM) and 3 (UTF-8). */
function id3Text(b: Uint8Array, encoding: number): string {
  if (encoding === 1) {
    if (hasBomLE(b)) return utf16Decode(b.subarray(2), true);
    if (hasBomBE(b)) return utf16Decode(b.subarray(2), false);
    return utf16Decode(b, false);
  }
  if (encoding === 3) return utf8Decode(b);
  return latin1(b);
}

// ---- Result shaping --------------------------------------------------------------------

/**
 * Sort, drop duplicate start times and force the first chapter to 0. Titles are trimmed and fall
 * back to "Chapter N". Returns null when there are fewer than two chapters to show.
 */
export function normalizeChapters(raw: { title: string; start: number }[]): EmbeddedChapter[] | null {
  if (raw.length < 2 || raw.length > MAX_CHAPTERS) return null;
  const sorted = raw
    .map((c) => ({ title: (c.title ?? '').replace(/\u0000/g, '').trim(), start: Number.isFinite(c.start) ? Math.max(0, c.start) : 0 }))
    .sort((a, b) => a.start - b.start);
  const out: EmbeddedChapter[] = [];
  let lastMs = Number.NaN;
  for (const c of sorted) {
    const ms = Math.round(c.start * 1000);
    if (ms === lastMs) continue;
    lastMs = ms;
    out.push(c);
  }
  if (out.length < 2) return null;
  out[0].start = 0;
  return out.map((c, i) => ({ title: c.title || `Chapter ${i + 1}`, start: c.start }));
}

/** How much a block-cached reader fetches at a time. */
export const RANGE_BLOCK = 128 * 1024;

/**
 * Wraps a range reader so the parser's many small reads (an atom header here, a chapter title there)
 * cost a few block-sized requests instead of one request each. Blocks are fetched once and kept.
 */
export function blockCached(readRange: ReadRange, size: number, block = RANGE_BLOCK): ReadRange {
  const blocks = new Map<number, Promise<Uint8Array>>();
  const get = (i: number) => {
    let b = blocks.get(i);
    if (!b) { b = readRange(i * block, Math.min(size, (i + 1) * block) - 1); blocks.set(i, b); }
    return b;
  };
  return async (start, endInclusive) => {
    const end = Math.min(endInclusive, size - 1);
    if (end < start) return new Uint8Array(0);
    const out = new Uint8Array(end - start + 1);
    for (let i = Math.floor(start / block); i <= Math.floor(end / block); i++) {
      const data = await get(i);
      const from = Math.max(start, i * block);
      const part = data.subarray(from - i * block, Math.min(end, i * block + data.length - 1) - i * block + 1);
      out.set(part, from - start);
      if (part.length < Math.min(end, (i + 1) * block - 1) - from + 1) return out.subarray(0, from - start + part.length); // short read
    }
    return out;
  };
}

/** Index of the chapter playing at `position`; -1 when there is no chapter list. */
export function chapterAt(chapters: EmbeddedChapter[], position: number): number {
  if (!chapters.length) return -1;
  let idx = 0;
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].start <= position) idx = i;
    else break;
  }
  return idx;
}

/** Where a chapter starts and where the next one takes over (the file's end for the last). */
export function chapterBounds(chapters: EmbeddedChapter[], index: number, duration: number): { start: number; end: number } {
  const start = chapters[index]?.start ?? 0;
  const next = chapters[index + 1]?.start;
  const end = Number.isFinite(next) ? next : Math.max(start, Number.isFinite(duration) ? duration : start);
  return { start, end: Math.max(start, end) };
}

// ---- Entry point -----------------------------------------------------------------------

/** Reads a file's own chapters, or null when it has none (or anything is malformed). */
export async function readEmbeddedChapters(readRange: ReadRange, size: number): Promise<EmbeddedChapter[] | null> {
  try {
    if (!(size > 8)) return null;
    const head = await readRange(0, Math.min(11, size - 1));
    if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return await readMp3(readRange, size);
    if (head.length >= 8 && str4(head, 4) === 'ftyp') return await readMp4(readRange, size);
    return null;
  } catch {
    return null;
  }
}

// ---- MP4 / M4B / M4A -------------------------------------------------------------------

type Atom = { type: string; start: number; end: number }; // [start, end) is the atom's payload

/** Header at `at`: 8 bytes, plus 8 more when the size is a 64-bit value. Never reads the payload. */
async function readHeader(readRange: ReadRange, at: number, parentEnd: number): Promise<Atom | null> {
  if (at + 8 > parentEnd) return null;
  const b = await readRange(at, Math.min(at + 7, parentEnd - 1));
  if (b.length < 8) return null;
  let sz = be32(b, 0);
  const type = str4(b, 4);
  let hs = 8;
  if (sz === 1) {
    if (at + 16 > parentEnd) return null;
    const b2 = await readRange(at + 8, Math.min(at + 15, parentEnd - 1));
    if (b2.length < 8) return null;
    sz = be64(b2, 0);
    hs = 16;
  } else if (sz === 0) {
    sz = parentEnd - at; // extends to the end of its parent
  }
  if (sz < hs || at + sz > parentEnd) return null;
  return { type, start: at + hs, end: at + sz };
}

async function child(readRange: ReadRange, parent: Atom, type: string): Promise<Atom | null> {
  let at = parent.start;
  while (at + 8 <= parent.end) {
    const a = await readHeader(readRange, at, parent.end);
    if (!a) return null;
    if (a.type === type) return a;
    at = a.end;
  }
  return null;
}

async function children(readRange: ReadRange, parent: Atom): Promise<Atom[]> {
  const out: Atom[] = [];
  let at = parent.start;
  while (at + 8 <= parent.end) {
    const a = await readHeader(readRange, at, parent.end);
    if (!a) break;
    out.push(a);
    at = a.end;
  }
  return out;
}

async function readMp4(readRange: ReadRange, size: number): Promise<EmbeddedChapter[] | null> {
  let moov: Atom | null = null;
  let at = 0;
  while (at + 8 <= size) {
    const a = await readHeader(readRange, at, size);
    if (!a) return null;
    if (a.type === 'moov') { moov = a; break; }
    at = a.end; // hop over mdat and friends without reading them
  }
  if (!moov || moov.end - moov.start > MAX_MOOV) return null;

  const qt = await quicktimeChapters(readRange, moov, size);
  if (qt && qt.some((c) => c.title.trim())) {
    const named = normalizeChapters(qt);
    if (named) return named;
  }
  const chpl = await chplChapters(readRange, moov);
  if (chpl) {
    const fromChpl = normalizeChapters(chpl);
    if (fromChpl) return fromChpl;
  }
  return qt ? normalizeChapters(qt) : null;
}

/** `udta/chpl`: version+flags, a count byte, then 100 ns starts with 1-byte-length titles. */
async function chplChapters(readRange: ReadRange, moov: Atom): Promise<{ title: string; start: number }[] | null> {
  const udta = await child(readRange, moov, 'udta');
  if (!udta) return null;
  const chpl = await child(readRange, udta, 'chpl');
  if (!chpl || chpl.end - chpl.start > MAX_MOOV) return null;
  const b = await readRange(chpl.start, chpl.end - 1);
  if (b.length < 5) return null;
  const version = b[0];
  let p = 4;
  if (version > 0) p += 4;
  if (p >= b.length) return null;
  const count = b[p++];
  if (count > MAX_CHAPTERS) return null;
  const out: { title: string; start: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 9 > b.length) break;
    const start = be64(b, p) / 10_000_000;
    p += 8;
    const len = b[p++];
    if (p + len > b.length) break;
    out.push({ title: utf8Decode(b.subarray(p, p + len)), start });
    p += len;
  }
  return out;
}

async function quicktimeChapters(readRange: ReadRange, moov: Atom, size: number): Promise<{ title: string; start: number }[] | null> {
  const tracks = (await children(readRange, moov)).filter((a) => a.type === 'trak');
  if (!tracks.length) return null;

  const chapIds = new Set<number>();
  const ids = new Map<Atom, number>();
  for (const t of tracks) {
    const tref = await child(readRange, t, 'tref');
    if (tref) {
      const chap = await child(readRange, tref, 'chap');
      if (chap) {
        const b = await readRange(chap.start, chap.end - 1);
        for (let i = 0; i + 4 <= b.length; i += 4) chapIds.add(be32(b, i));
      }
    }
    const tkhd = await child(readRange, t, 'tkhd');
    if (tkhd) {
      const b = await readRange(tkhd.start, Math.min(tkhd.end - 1, tkhd.start + 19));
      if (b.length >= 16) {
        const off = b[0] === 1 ? 16 : 12;
        if (b.length >= off + 4) ids.set(t, be32(b, off));
      }
    }
  }

  const text = tracks.find((t) => chapIds.has(ids.get(t) ?? -1));
  if (!text) return null;
  const mdia = await child(readRange, text, 'mdia');
  const minf = mdia && await child(readRange, mdia, 'minf');
  const stbl = minf && await child(readRange, minf, 'stbl');
  if (!mdia || !stbl) return null;

  const mdhd = await child(readRange, mdia, 'mdhd');
  const timescale = mdhd ? await readTimescale(readRange, mdhd) : null;
  const stts = await child(readRange, stbl, 'stts');
  const stsc = await child(readRange, stbl, 'stsc');
  const stsz = await child(readRange, stbl, 'stsz');
  const offsets = (await child(readRange, stbl, 'stco')) ?? (await child(readRange, stbl, 'co64'));
  if (!timescale || !stts || !stsc || !stsz || !offsets) return null;

  const sizes = await readStsz(readRange, stsz);
  const chunks = await readStsc(readRange, stsc);
  const chunkOffsets = await readChunkOffsets(readRange, offsets);
  if (!sizes || !chunks || !chunkOffsets || !sizes.length) return null;

  const sampleOffsets = mapSampleOffsets(chunks, chunkOffsets, sizes);
  const times = await readSampleTimes(readRange, stts, sizes.length, timescale);
  if (!sampleOffsets || !times) return null;

  const texts = await readTextSamples(readRange, sizes.map((s, i) => ({ size: s, offset: sampleOffsets[i] })), size);
  return sizes.map((_, i) => ({ title: texts[i] ?? '', start: times[i] }));
}

async function readTimescale(readRange: ReadRange, mdhd: Atom): Promise<number | null> {
  const b = await readRange(mdhd.start, Math.min(mdhd.end - 1, mdhd.start + 23));
  if (b.length < 4) return null;
  const off = b[0] === 1 ? 20 : 12;
  if (b.length < off + 4) return null;
  const ts = be32(b, off);
  return ts > 0 ? ts : null;
}

async function readStsz(readRange: ReadRange, atom: Atom): Promise<number[] | null> {
  const b = await readRange(atom.start, atom.end - 1);
  if (b.length < 12) return null;
  const sampleSize = be32(b, 4);
  const count = be32(b, 8);
  if (count > MAX_CHAPTERS) return null;
  if (sampleSize > 0) return new Array(count).fill(sampleSize);
  if (b.length < 12 + count * 4) return null;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(be32(b, 12 + i * 4));
  return out;
}

type StscEntry = { firstChunk: number; samplesPerChunk: number };

async function readStsc(readRange: ReadRange, atom: Atom): Promise<StscEntry[] | null> {
  const b = await readRange(atom.start, atom.end - 1);
  if (b.length < 8) return null;
  const count = be32(b, 4);
  if (count > MAX_TABLE_ENTRIES || b.length < 8 + count * 12) return null;
  const out: StscEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ firstChunk: be32(b, 8 + i * 12), samplesPerChunk: be32(b, 12 + i * 12) });
  }
  return out.sort((a, b) => a.firstChunk - b.firstChunk);
}

async function readChunkOffsets(readRange: ReadRange, atom: Atom): Promise<number[] | null> {
  const b = await readRange(atom.start, atom.end - 1);
  if (b.length < 8) return null;
  const count = be32(b, 4);
  const wide = atom.type === 'co64';
  const step = wide ? 8 : 4;
  if (count > MAX_TABLE_ENTRIES || b.length < 8 + count * step) return null;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(wide ? be64(b, 8 + i * step) : be32(b, 8 + i * step));
  return out;
}

function mapSampleOffsets(chunks: StscEntry[], offsets: number[], sizes: number[]): number[] | null {
  const out = new Array<number>(sizes.length).fill(-1);
  if (!chunks.length) {
    if (offsets.length < sizes.length) return null;
    for (let i = 0; i < sizes.length; i++) out[i] = offsets[i];
    return out;
  }
  let sample = 0;
  let entry = 0;
  for (let chunk = 1; chunk <= offsets.length && sample < sizes.length; chunk++) {
    while (entry + 1 < chunks.length && chunks[entry + 1].firstChunk <= chunk) entry++;
    let off = offsets[chunk - 1];
    for (let k = 0; k < chunks[entry].samplesPerChunk && sample < sizes.length; k++) {
      out[sample] = off;
      off += sizes[sample];
      sample++;
    }
  }
  return out.some((o) => o < 0) ? null : out;
}

async function readSampleTimes(readRange: ReadRange, atom: Atom, count: number, timescale: number): Promise<number[] | null> {
  const b = await readRange(atom.start, atom.end - 1);
  if (b.length < 8) return null;
  const entries = be32(b, 4);
  if (entries > MAX_TABLE_ENTRIES || b.length < 8 + entries * 8) return null;
  const durations: number[] = [];
  for (let i = 0; i < entries && durations.length < count; i++) {
    const n = be32(b, 8 + i * 8);
    const d = be32(b, 12 + i * 8);
    for (let k = 0; k < n && durations.length < count; k++) durations.push(d);
  }
  while (durations.length < count) durations.push(0);
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) { out.push(t / timescale); t += durations[i]; }
  return out;
}

/** Chapter text samples are `[2-byte length][UTF-8 or UTF-16]`; nearby ones are read in one range. */
async function readTextSamples(readRange: ReadRange, samples: { size: number; offset: number }[], fileSize: number): Promise<(string | null)[]> {
  const out = new Array<string | null>(samples.length).fill(null);
  const order = samples.map((_, i) => i)
    .filter((i) => samples[i].size > 1 && samples[i].offset >= 0)
    .sort((a, b) => samples[a].offset - samples[b].offset);

  const groups: { start: number; end: number; items: number[] }[] = [];
  for (const i of order) {
    const start = samples[i].offset;
    const end = Math.min(start + samples[i].size, fileSize);
    if (end <= start) continue;
    const g = groups[groups.length - 1];
    if (g && start >= g.start && start - g.end <= 4096) { g.end = Math.max(g.end, end); g.items.push(i); }
    else groups.push({ start, end, items: [i] });
  }

  for (const g of groups) {
    const b = await readRange(g.start, g.end - 1);
    for (const i of g.items) {
      const rel = samples[i].offset - g.start;
      if (rel < 0 || rel + 2 > b.length) continue;
      const len = be16(b, rel);
      const from = rel + 2;
      const to = Math.min(from + len, b.length);
      const bytes = b.subarray(from, to);
      out[i] = hasBomLE(bytes) ? utf16Decode(bytes.subarray(2), true)
        : hasBomBE(bytes) ? utf16Decode(bytes.subarray(2), false)
          : utf8Decode(bytes);
    }
  }
  return out;
}

// ---- MP3 -------------------------------------------------------------------------------

async function readMp3(readRange: ReadRange, size: number): Promise<EmbeddedChapter[] | null> {
  const head = await readRange(0, Math.min(9, size - 1));
  if (head.length < 10) return null;
  const major = head[3];
  if (major !== 3 && major !== 4) return null;
  const tagSize = syncsafe(head, 6);
  if (tagSize <= 0 || tagSize > MAX_ID3_TAG) return null;
  const tagEnd = 10 + tagSize;
  if (tagEnd > size) return null;
  const tag = await readRange(10, tagEnd - 1);
  const frames = parseFrames(tag, major, head[5]);

  const chapters = new Map<string, { title: string; start: number }>();
  let ctoc: string[] | null = null;
  let seq = 0;
  for (const f of frames) {
    if (f.id === 'CHAP') {
      const c = parseChap(f.data, major, seq++);
      if (c) chapters.set(c.id, { title: c.title, start: c.start });
    } else if (f.id === 'CTOC' && !ctoc) {
      ctoc = parseCtoc(f.data);
    }
  }
  if (chapters.size < 2) return null;

  const raw: { title: string; start: number }[] = [];
  const used = new Set<string>();
  for (const id of ctoc ?? []) {
    const c = chapters.get(id);
    if (c && !used.has(id)) { used.add(id); raw.push({ title: c.title, start: c.start }); }
  }
  for (const [id, c] of chapters) if (!used.has(id)) raw.push({ title: c.title, start: c.start });
  return normalizeChapters(raw);
}

type Frame = { id: string; data: Uint8Array };

function parseFrames(tag: Uint8Array, major: number, flags: number): Frame[] {
  let p = 0;
  if (flags & 0x40) { // extended header
    if (tag.length < 4) return [];
    p = 4 + (major === 4 ? syncsafe(tag, 0) : be32(tag, 0));
  }
  const out: Frame[] = [];
  while (p + 10 <= tag.length) {
    const id = str4(tag, p);
    if (!isFrameId(id)) break;
    const size = major === 4 ? syncsafe(tag, p + 4) : be32(tag, p + 4);
    const start = p + 10;
    if (size <= 0 || start + size > tag.length) break;
    out.push({ id, data: tag.subarray(start, start + size) });
    p = start + size;
  }
  return out;
}

/** Reads a UTF-16 BOM pair or a single null as the element id terminator. */
function idTerminator(data: Uint8Array, encoding: number, from: number): number {
  if (encoding === 1) {
    for (let i = from; i + 1 < data.length; i += 2) if (data[i] === 0 && data[i + 1] === 0) return i;
    return -1;
  }
  return data.indexOf(0, from);
}

function parseChap(data: Uint8Array, major: number, seq: number): { id: string; title: string; start: number } | null {
  if (data.length < 1) return null;
  const encoding = data[0];
  const term = encoding === 1 ? 2 : 1;
  const idEnd = idTerminator(data, encoding, 1);
  if (idEnd < 0) return null;
  const id = id3Text(data.subarray(1, idEnd), encoding) || `chap-${seq}`;
  const p = idEnd + term;
  if (p + 16 > data.length) return null;
  const start = be32(data, p) / 1000; // ms -> seconds
  return { id, title: tit2(data.subarray(p + 16), major) ?? '', start };
}

function tit2(sub: Uint8Array, major: number): string | null {
  let p = 0;
  while (p + 10 <= sub.length) {
    const id = str4(sub, p);
    if (!isFrameId(id)) break;
    const size = major === 4 ? syncsafe(sub, p + 4) : be32(sub, p + 4);
    const start = p + 10;
    if (size <= 1 || start + size > sub.length) break;
    if (id === 'TIT2') return id3Text(sub.subarray(start + 1, start + size), sub[start]).trim();
    p = start + size;
  }
  return null;
}

/** CTOC: element id, a flags byte and an entry count, then the child id list in playback order. */
function parseCtoc(data: Uint8Array): string[] | null {
  if (data.length < 1) return null;
  const encoding = data[0];
  const term = encoding === 1 ? 2 : 1;
  const idEnd = idTerminator(data, encoding, 1);
  if (idEnd < 0) return null;
  let p = idEnd + term;
  if (p + 2 > data.length) return null;
  const count = data[p + 1];
  p += 2;
  const out: string[] = [];
  for (let i = 0; i < count && p < data.length; i++) {
    const end = idTerminator(data, encoding, p);
    if (end < 0) break;
    out.push(id3Text(data.subarray(p, end), encoding));
    p = end + term;
  }
  return out;
}
