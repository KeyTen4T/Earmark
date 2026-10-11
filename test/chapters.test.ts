import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEmbeddedChapters, normalizeChapters, chapterAt, chapterBounds, type ReadRange } from '../src/chapters/embedded';
import { fetchEmbeddedChapters } from '../src/chapters/fetch';

// ---- byte builders ---------------------------------------------------------------------

const enc = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(ascii(type), 4);
  out.set(payload, 8);
  return out;
}

function full(type: string, version: number, flags: number, rest: Uint8Array): Uint8Array {
  return box(type, cat(Uint8Array.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), rest));
}

/** A reader over fixed bytes that records what was asked for. */
function makeReader(bytes: Uint8Array) {
  const calls: { start: number; end: number }[] = [];
  const readRange: ReadRange = async (start, end) => {
    calls.push({ start, end });
    return bytes.slice(Math.max(0, start), Math.min(end + 1, bytes.length));
  };
  const bytesRead = () => calls.reduce((n, c) => n + Math.max(0, Math.min(c.end, bytes.length - 1) - c.start + 1), 0);
  return { readRange, calls, bytesRead };
}

// ---- MP4 -------------------------------------------------------------------------------

function chpl(entries: { title: string; start100ns: number }[], version = 0): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([version, 0, 0, 0])];
  if (version > 0) parts.push(new Uint8Array(4));
  parts.push(Uint8Array.from([entries.length]));
  for (const e of entries) {
    const t = enc(e.title);
    const b = new Uint8Array(9 + t.length);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, Math.floor(e.start100ns / 4294967296), false);
    dv.setUint32(4, e.start100ns >>> 0, false);
    b[8] = t.length;
    b.set(t, 9);
    parts.push(b);
  }
  return cat(...parts);
}

const moovWithChpl = (entries: { title: string; start100ns: number }[]) => box('moov', box('udta', box('chpl', chpl(entries))));
const ftyp = () => box('ftyp', ascii('isomiso2'));

test('chapters: chpl in a moov at the start', async () => {
  const moov = moovWithChpl([
    { title: 'Intro', start100ns: 30_000_000 }, // 3 s -> forced to 0
    { title: 'Part One', start100ns: 50_000_000 }, // 5 s
    { title: '  Part Two  ', start100ns: 90_000_000 }, // 9 s, trimmed
  ]);
  const mdat = box('mdat', new Uint8Array(100_000).fill(7));
  const mdatPayload = ftyp().length + moov.length + 8;
  const bytes = cat(ftyp(), moov, mdat);

  const { readRange, calls, bytesRead } = makeReader(bytes);
  assert.deepEqual(await readEmbeddedChapters(readRange, bytes.length), [
    { title: 'Intro', start: 0 },
    { title: 'Part One', start: 5 },
    { title: 'Part Two', start: 9 },
  ]);
  // The whole mdat is hopped over: no read may touch its payload.
  assert.ok(calls.every((c) => c.end < mdatPayload), 'mdat payload must not be fetched');
  assert.ok(bytesRead() < 4096, `read ${bytesRead()} bytes`);
});

test('chapters: chpl in a moov at the end', async () => {
  const moov = moovWithChpl([
    { title: 'One', start100ns: 0 },
    { title: 'Two', start100ns: 120_000_000 },
  ]);
  const mdat = box('mdat', new Uint8Array(80_000).fill(3));
  const mdatDataStart = ftyp().length + 8;
  const bytes = cat(ftyp(), mdat, moov);

  const { readRange, calls } = makeReader(bytes);
  assert.deepEqual(await readEmbeddedChapters(readRange, bytes.length), [
    { title: 'One', start: 0 },
    { title: 'Two', start: 12 },
  ]);
  assert.ok(calls.every((c) => c.end < mdatDataStart || c.start >= mdatDataStart + 80_000), 'mdat payload must not be fetched');
});

test('chapters: a version-1 chpl skips its reserved word', async () => {
  const moov = box('moov', box('udta', box('chpl', chpl([
    { title: 'A', start100ns: 0 },
    { title: 'B', start100ns: 10_000_000 },
  ], 1))));
  const bytes = cat(ftyp(), moov, box('mdat', new Uint8Array(16)));
  const { readRange } = makeReader(bytes);
  assert.deepEqual(await readEmbeddedChapters(readRange, bytes.length), [
    { title: 'A', start: 0 },
    { title: 'B', start: 1 },
  ]);
});

// ---- QuickTime chapter tracks ----------------------------------------------------------

const tkhd = (id: number) => {
  const rest = new Uint8Array(16);
  new DataView(rest.buffer).setUint32(8, id, false);
  return full('tkhd', 0, 0, rest);
};
const chapTref = (ids: number[]) => {
  const p = new Uint8Array(ids.length * 4);
  ids.forEach((id, i) => new DataView(p.buffer).setUint32(i * 4, id, false));
  return box('tref', box('chap', p));
};
const mdhd = (timescale: number) => {
  const rest = new Uint8Array(12);
  new DataView(rest.buffer).setUint32(8, timescale, false);
  return full('mdhd', 0, 0, rest);
};
const stts = (entries: [number, number][]) => {
  const rest = new Uint8Array(4 + entries.length * 8);
  const dv = new DataView(rest.buffer);
  dv.setUint32(0, entries.length, false);
  entries.forEach(([n, d], i) => { dv.setUint32(4 + i * 8, n, false); dv.setUint32(8 + i * 8, d, false); });
  return full('stts', 0, 0, rest);
};
const stsc = (entries: [number, number, number][]) => {
  const rest = new Uint8Array(4 + entries.length * 12);
  const dv = new DataView(rest.buffer);
  dv.setUint32(0, entries.length, false);
  entries.forEach(([fc, spc, d], i) => { dv.setUint32(4 + i * 12, fc, false); dv.setUint32(8 + i * 12, spc, false); dv.setUint32(12 + i * 12, d, false); });
  return full('stsc', 0, 0, rest);
};
const stsz = (sizes: number[]) => {
  const rest = new Uint8Array(8 + sizes.length * 4);
  const dv = new DataView(rest.buffer);
  dv.setUint32(4, sizes.length, false);
  sizes.forEach((s, i) => dv.setUint32(8 + i * 4, s, false));
  return full('stsz', 0, 0, rest);
};
const stco = (offsets: number[]) => {
  const rest = new Uint8Array(4 + offsets.length * 4);
  const dv = new DataView(rest.buffer);
  dv.setUint32(0, offsets.length, false);
  offsets.forEach((o, i) => dv.setUint32(4 + i * 4, o, false));
  return full('stco', 0, 0, rest);
};
const co64 = (offsets: number[]) => {
  const rest = new Uint8Array(4 + offsets.length * 8);
  const dv = new DataView(rest.buffer);
  dv.setUint32(0, offsets.length, false);
  offsets.forEach((o, i) => {
    dv.setUint32(4 + i * 8, Math.floor(o / 4294967296), false);
    dv.setUint32(8 + i * 8, o >>> 0, false);
  });
  return full('co64', 0, 0, rest);
};

/** text samples as `[2-byte length][UTF-8]`, then a moov at the end pointing at them via stco/co64. */
function quicktime(buildChunkOffsets: (offsets: number[]) => Uint8Array, titles: string[], durationsMs: number[], extra?: Uint8Array) {
  const samples = titles.map((t) => {
    const txt = enc(t);
    return cat(Uint8Array.from([txt.length >> 8, txt.length & 0xff]), txt);
  });
  const mdat = box('mdat', cat(...samples));
  const base = ftyp().length + 8;
  const offsets: number[] = [];
  let at = base;
  for (const s of samples) { offsets.push(at); at += s.length; }

  const stbl = box('stbl', cat(stts(durationsMs.map((d) => [1, d] as [number, number])), stsc([[1, 1, 1]]), stsz(samples.map((s) => s.length)), buildChunkOffsets(offsets)));
  const textTrak = box('trak', cat(tkhd(2), box('mdia', cat(mdhd(1000), box('minf', stbl)))));
  const audioTrak = box('trak', cat(tkhd(1), chapTref([2])));
  const moov = box('moov', cat(audioTrak, textTrak, extra ?? new Uint8Array(0)));
  return cat(ftyp(), mdat, moov);
}

test('chapters: a QuickTime text track with stco', async () => {
  const bytes = quicktime(stco, ['Opening', 'The Middle', 'The End'], [5000, 7000, 3000]);
  const { readRange } = makeReader(bytes);
  assert.deepEqual(await readEmbeddedChapters(readRange, bytes.length), [
    { title: 'Opening', start: 0 },
    { title: 'The Middle', start: 5 },
    { title: 'The End', start: 12 },
  ]);
});

test('chapters: a QuickTime text track with co64', async () => {
  const bytes = quicktime(co64, ['First', 'Second'], [4000, 6000]);
  const { readRange } = makeReader(bytes);
  assert.deepEqual(await readEmbeddedChapters(readRange, bytes.length), [
    { title: 'First', start: 0 },
    { title: 'Second', start: 4 },
  ]);
});

test('chapters: UTF-16 text samples decode too', async () => {
  const make = (t: string) => {
    const body = cat(Uint8Array.from([0xff, 0xfe]), new Uint8Array(Buffer.from(t, 'utf16le')));
    return cat(Uint8Array.from([body.length >> 8, body.length & 0xff]), body);
  };
  const samples = [make('Café'), make('Fin')];
  const mdat = box('mdat', cat(...samples));
  const base = ftyp().length + 8;
  const offsets: number[] = [];
  let at = base;
  for (const s of samples) { offsets.push(at); at += s.length; }
  const stbl = box('stbl', cat(stts([[2, 5000]]), stsc([[1, 1, 1]]), stsz(samples.map((s) => s.length)), stco(offsets)));
  const textTrak = box('trak', cat(tkhd(2), box('mdia', cat(mdhd(1000), box('minf', stbl)))));
  const moov = box('moov', cat(box('trak', cat(tkhd(1), chapTref([2]))), textTrak));
  const bytes = cat(ftyp(), mdat, moov);
  const { readRange } = makeReader(bytes);
  assert.deepEqual(await readEmbeddedChapters(readRange, bytes.length), [
    { title: 'Café', start: 0 },
    { title: 'Fin', start: 5 },
  ]);
});

test('chapters: a QuickTime track with titles beats chpl', async () => {
  const udta = box('udta', box('chpl', chpl([{ title: 'Nero One', start100ns: 0 }, { title: 'Nero Two', start100ns: 12_000_000 }])));
  const bytes = quicktime(stco, ['QT One', 'QT Two'], [5000, 5000], udta);
  const { readRange } = makeReader(bytes);
  assert.deepEqual(await readEmbeddedChapters(readRange, bytes.length), [
    { title: 'QT One', start: 0 },
    { title: 'QT Two', start: 5 },
  ]);
});

test('chapters: falls back to chpl when the QuickTime track has no titles', async () => {
  const udta = box('udta', box('chpl', chpl([{ title: 'Nero One', start100ns: 0 }, { title: 'Nero Two', start100ns: 10_000_000 }])));
  const bytes = quicktime(stco, ['', ''], [5000, 5000], udta);
  const { readRange } = makeReader(bytes);
  assert.deepEqual(await readEmbeddedChapters(readRange, bytes.length), [
    { title: 'Nero One', start: 0 },
    { title: 'Nero Two', start: 1 },
  ]);
});

// ---- MP3 -------------------------------------------------------------------------------

function id3Frame(id: string, data: Uint8Array, major: number): Uint8Array {
  const head = new Uint8Array(10);
  head.set(ascii(id), 0);
  if (major === 4) {
    head[4] = (data.length >> 21) & 0x7f; head[5] = (data.length >> 14) & 0x7f;
    head[6] = (data.length >> 7) & 0x7f; head[7] = data.length & 0x7f;
  } else {
    new DataView(head.buffer).setUint32(4, data.length, false);
  }
  return cat(head, data);
}

function id3Text(text: string, encoding: number): Uint8Array {
  if (encoding === 0) return cat(Uint8Array.from([0]), ascii(text));
  if (encoding === 3) return cat(Uint8Array.from([3]), enc(text));
  return cat(Uint8Array.from([1, 0xff, 0xfe]), new Uint8Array(Buffer.from(text, 'utf16le')));
}

function chap(id: string, startMs: number, endMs: number, title: string | null, encoding: number, major: number): Uint8Array {
  const idBytes = encoding === 1
    ? cat(new Uint8Array(Buffer.from(id, 'utf16le')), Uint8Array.from([0, 0]))
    : cat(ascii(id), Uint8Array.from([0]));
  const times = new Uint8Array(16);
  const dv = new DataView(times.buffer);
  dv.setUint32(0, startMs, false); dv.setUint32(4, endMs, false);
  const body = cat(Uint8Array.from([encoding]), idBytes, times, title != null ? id3Frame('TIT2', id3Text(title, encoding), major) : new Uint8Array(0));
  return id3Frame('CHAP', body, major);
}

function ctoc(ids: string[], encoding: number, major: number): Uint8Array {
  const idBytes = encoding === 1
    ? cat(new Uint8Array(Buffer.from('toc', 'utf16le')), Uint8Array.from([0, 0]))
    : cat(ascii('toc'), Uint8Array.from([0]));
  const children = ids.map((id) => encoding === 1
    ? cat(new Uint8Array(Buffer.from(id, 'utf16le')), Uint8Array.from([0, 0]))
    : cat(ascii(id), Uint8Array.from([0])));
  return id3Frame('CTOC', cat(Uint8Array.from([encoding]), idBytes, Uint8Array.from([0x03, ids.length]), ...children), major);
}

function id3(frames: Uint8Array[], major: number): Uint8Array {
  const body = cat(...frames);
  const head = new Uint8Array(10);
  head.set(ascii('ID3'), 0);
  head[3] = major;
  head[6] = (body.length >> 21) & 0x7f; head[7] = (body.length >> 14) & 0x7f;
  head[8] = (body.length >> 7) & 0x7f; head[9] = body.length & 0x7f;
  return cat(head, body, enc('audio'));
}

test('chapters: ID3v2.3 CHAP frames, Latin-1 titles', async () => {
  const bytes = id3([
    chap('ch1', 0, 5000, 'Intro', 0, 3),
    chap('ch2', 5000, 12000, 'Middle', 0, 3),
    chap('ch3', 12000, 15000, null, 0, 3),
  ], 3);
  const { readRange } = makeReader(bytes);
  assert.deepEqual(await readEmbeddedChapters(readRange, bytes.length), [
    { title: 'Intro', start: 0 },
    { title: 'Middle', start: 5 },
    { title: 'Chapter 3', start: 12 },
  ]);
});

test('chapters: ID3v2.4 CHAP frames, UTF-8 and UTF-16 titles', async () => {
  const bytes = id3([
    chap('a', 0, 4000, 'Café', 3, 4),
    chap('b', 4000, 9000, 'Über', 1, 4),
  ], 4);
  const { readRange } = makeReader(bytes);
  assert.deepEqual(await readEmbeddedChapters(readRange, bytes.length), [
    { title: 'Café', start: 0 },
    { title: 'Über', start: 4 },
  ]);
});

test('chapters: CTOC is read but the result is sorted by start', async () => {
  const bytes = id3([
    ctoc(['c', 'a', 'b'], 0, 4),
    chap('a', 0, 5000, 'Alpha', 0, 4),
    chap('b', 5000, 9000, 'Bravo', 0, 4),
    chap('c', 9000, 11000, 'Charlie', 0, 4),
  ], 4);
  const { readRange } = makeReader(bytes);
  assert.deepEqual(await readEmbeddedChapters(readRange, bytes.length), [
    { title: 'Alpha', start: 0 },
    { title: 'Bravo', start: 5 },
    { title: 'Charlie', start: 9 },
  ]);
});

// ---- Bad input -------------------------------------------------------------------------

test('chapters: malformed and truncated inputs return null, not throw', async () => {
  const cases: Uint8Array[] = [
    new Uint8Array(0),
    ascii('nonsense bytes here'),
    cat(ascii('ID3'), Uint8Array.from([4, 0, 0, 0, 0, 0x40, 0x00]), new Uint8Array(8)), // header claims a longer tag than the file has
    cat(ftyp(), box('moov', ascii('not really atoms'))),
  ];
  for (const bytes of cases) {
    const { readRange } = makeReader(bytes);
    assert.equal(await readEmbeddedChapters(readRange, bytes.length), null);
  }
});

test('chapters: a moov larger than the cap is refused without reading it', async () => {
  const head = cat(ftyp(), (() => {
    const h = new Uint8Array(8);
    new DataView(h.buffer).setUint32(0, 20 * 1024 * 1024, false);
    h.set(ascii('moov'), 4);
    return h;
  })());
  const size = ftyp().length + 20 * 1024 * 1024;
  const calls: { start: number; end: number }[] = [];
  const readRange: ReadRange = async (start, end) => {
    calls.push({ start, end });
    const out = new Uint8Array(Math.max(0, Math.min(end, size - 1) - start + 1));
    const from = Math.max(0, start);
    if (from < head.length) out.set(head.subarray(from, Math.min(head.length, end + 1)), 0);
    return out;
  };
  assert.equal(await readEmbeddedChapters(readRange, size), null);
  assert.ok(calls.every((c) => c.end < ftyp().length + 8), 'never enters the oversized moov');
});

// ---- Helpers and shaping ---------------------------------------------------------------

test('chapters: normalizeChapters shapes and rejects', () => {
  assert.equal(normalizeChapters([]), null);
  assert.equal(normalizeChapters([{ title: 'only', start: 0 }]), null);
  assert.deepEqual(normalizeChapters([
    { title: 'B', start: 10 },
    { title: 'A', start: 2 },
    { title: 'dup', start: 10 },
  ]), [{ title: 'A', start: 0 }, { title: 'B', start: 10 }]);
});

test('chapters: chapterAt and chapterBounds', () => {
  const ch = [{ title: 'A', start: 0 }, { title: 'B', start: 10 }, { title: 'C', start: 25 }];
  assert.equal(chapterAt(ch, 0), 0);
  assert.equal(chapterAt(ch, 9.9), 0);
  assert.equal(chapterAt(ch, 10), 1);
  assert.equal(chapterAt(ch, 24), 1);
  assert.equal(chapterAt(ch, 999), 2);
  assert.deepEqual(chapterBounds(ch, 1, 40), { start: 10, end: 25 });
  assert.deepEqual(chapterBounds(ch, 2, 40), { start: 25, end: 40 });
  // An unknown duration still yields a non-degenerate last chapter.
  assert.deepEqual(chapterBounds(ch, 2, 0), { start: 25, end: 25 });
});

// ---- The HTTP reader -------------------------------------------------------------------

test('chapters: the fetcher ranges the URL and reports 200-with-body as no chapters', async () => {
  const moov = moovWithChpl([{ title: 'A', start100ns: 0 }, { title: 'B', start100ns: 10_000_000 }]);
  const bytes = cat(ftyp(), moov, box('mdat', new Uint8Array(50_000)));
  const reads: string[] = [];
  const ranged = (async (_url: string, init: any) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    reads.push(init.headers.Range);
    const start = Number(m![1]);
    const end = Number(m![2]);
    const body = bytes.slice(start, Math.min(end + 1, bytes.length));
    return { status: 206, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
  }) as unknown as typeof fetch;
  assert.deepEqual(await fetchEmbeddedChapters('https://example/stream', bytes.length, ranged), [
    { title: 'A', start: 0 },
    { title: 'B', start: 1 },
  ]);
  assert.ok(reads.every((r) => Number(/bytes=(\d+)/.exec(r)![1]) < moov.length + ftyp().length), 'no read inside mdat');

  let cancelled = false;
  const wholeBody = (async () => ({ status: 200, body: { cancel: async () => { cancelled = true; } } })) as unknown as typeof fetch;
  assert.equal(await fetchEmbeddedChapters('https://example/stream', bytes.length, wholeBody), null);
  assert.ok(cancelled, 'the whole-body response is aborted');

  const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  await assert.rejects(fetchEmbeddedChapters('https://example/stream', bytes.length, down), /offline/);
});
