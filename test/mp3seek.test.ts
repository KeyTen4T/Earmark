import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeSeekMap, seekByte, trueTimeAtByte, playerToTrue, trueToSeekTarget,
  ffmpegSeekSlot, ffmpegSeekByte, ffmpegSlotTimestamp, ffmpegSlotError, trueToSeekTargetFfmpeg,
  type XingSeekMap,
} from '../src/readalong/mp3seek';
import { fromAnchorsJson } from '../src/readalong/anchors';
import { parseDoc } from '../src/sync/merge';

// Real Dune parameters (torrent d6eb04c3…, file 0): the first frame's Xing tag. `toc` and the
// expected `seekByte` values come from executing androidx.media3.extractor.mp3.XingSeeker 1.9.0
// (media3-extractor-1.9.0.aar) against this exact header.
const DUNE_TOC = [
  0, 2, 5, 7, 10, 12, 15, 17, 20, 22, 25, 28, 30, 33, 35, 38, 40, 43, 46, 48, 51, 53, 55, 58, 61,
  63, 66, 68, 71, 74, 76, 79, 81, 84, 86, 89, 91, 94, 97, 99, 102, 104, 107, 109, 112, 115, 117,
  119, 122, 125, 127, 130, 133, 135, 137, 140, 143, 145, 148, 151, 153, 155, 158, 161, 163, 166,
  169, 171, 174, 176, 179, 182, 184, 187, 189, 191, 194, 197, 199, 202, 205, 207, 209, 212, 214,
  217, 220, 222, 225, 227, 230, 233, 235, 238, 240, 243, 245, 248, 251, 253,
];

const DUNE: XingSeekMap = {
  v: 1,
  kind: 'xing',
  xingFramePosition: 2171090,
  xingFrameSize: 417,
  dataStartPosition: 2171507,
  dataSize: 1128507515,
  durationUs: 82414053854,
  toc: DUNE_TOC,
  tableStartByte: 2171507,
  tableEndByte: 1130678604,
  intervals: 4096,
  t0cs: 0,
  deltaCs: new Array(4096).fill(0),
};

// A tiny map whose table is exact, for interpolation and inversion tests.
function smallMap(): XingSeekMap {
  const toc = Array.from({ length: 100 }, (_, i) => Math.round((i * 255) / 99));
  return {
    v: 1, kind: 'xing',
    xingFramePosition: 100, xingFrameSize: 10, dataStartPosition: 110,
    dataSize: 400, durationUs: 4_000_000, toc,
    tableStartByte: 110, tableEndByte: 510, intervals: 4,
    t0cs: 0, deltaCs: [100, 100, 100, 100],
  };
}

test('decodeSeekMap accepts a well-formed map and copies it', () => {
  const m = decodeSeekMap({ ...DUNE });
  assert.ok(m);
  assert.equal(m!.kind, 'xing');
  assert.equal(m!.toc.length, 100);
  assert.equal(m!.deltaCs.length, m!.intervals);
});

test('decodeSeekMap rejects malformed or unknown maps', () => {
  assert.equal(decodeSeekMap(null), null);
  assert.equal(decodeSeekMap('x'), null);
  assert.equal(decodeSeekMap({ ...DUNE, v: 2 }), null);
  assert.equal(decodeSeekMap({ ...DUNE, kind: 'info' }), null);
  assert.equal(decodeSeekMap({ ...DUNE, toc: DUNE_TOC.slice(0, 99) }), null);
  assert.equal(decodeSeekMap({ ...DUNE, toc: [...DUNE_TOC.slice(0, 99), 999] }), null);
  assert.equal(decodeSeekMap({ ...DUNE, intervals: 4095 }), null);
  assert.equal(decodeSeekMap({ ...DUNE, deltaCs: [1, -1, ...new Array(4094).fill(1)] }), null);
  assert.equal(decodeSeekMap({ ...DUNE, dataSize: 0 }), null);
});

test('seekByte matches the real media3 XingSeeker byte positions', () => {
  const cases: [number, number][] = [
    [600, 8589751],
    [3600, 49499523],
    [21600, 294958151],
    [45700, 625297331],
    [45968, 629597834],
    [64800, 887706083],
    [79200, 1083512030],
  ];
  for (const [T, byte] of cases) assert.equal(seekByte(DUNE, T), byte, `T=${T}`);
});

test('seekByte clamps at both ends', () => {
  // percent <= 0 clamps the offset up to the Xing frame size; >= 100 clamps to dataSize - 1.
  assert.equal(seekByte(DUNE, 0), DUNE.xingFramePosition + DUNE.xingFrameSize);
  assert.equal(seekByte(DUNE, -5), DUNE.xingFramePosition + DUNE.xingFrameSize);
  assert.equal(seekByte(DUNE, 1e9), DUNE.xingFramePosition + DUNE.dataSize - 1);
});

test('trueTimeAtByte interpolates the table linearly', () => {
  const m = smallMap();
  assert.equal(trueTimeAtByte(m, 110), 0);
  assert.equal(trueTimeAtByte(m, 510), 4);
  assert.equal(trueTimeAtByte(m, 210), 1);
  assert.equal(trueTimeAtByte(m, 310), 2);
  assert.equal(trueTimeAtByte(m, 260), 1.5);
  // Beyond either end it clamps to the first/last sample.
  assert.equal(trueTimeAtByte(m, 0), 0);
  assert.equal(trueTimeAtByte(m, 100000), 4);
});

test('playerToTrue leaves the clock alone with no seek', () => {
  const m = smallMap();
  assert.equal(playerToTrue(m, null, 123.4), 123.4);
  assert.equal(playerToTrue(m, undefined, 7), 7);
});

test('playerToTrue applies the seek landing offset', () => {
  const m = smallMap();
  for (const T of [0.5, 1, 2, 3.7]) {
    const landing = trueTimeAtByte(m, seekByte(m, T));
    assert.ok(Math.abs(playerToTrue(m, T, T) - landing) < 1e-9);
    assert.ok(Math.abs(playerToTrue(m, T, T + 5) - (landing + 5)) < 1e-9);
  }
});

test('fromAnchorsJson keeps a valid seek map and drops an invalid one', () => {
  const record = fromAnchorsJson({
    timing: 'word',
    files: [
      { id: 1, duration: 10, anchors: [{ t: 1, para: 0, word: 0 }], seek: DUNE },
      { id: 2, duration: 10, anchors: [], seek: { v: 9 } },
    ],
  }, { hash: 'h', fileId: 1 });
  assert.ok(record.files[0].seek);
  assert.equal(record.files[0].seek!.kind, 'xing');
  assert.equal(record.files[1].seek, undefined);
});

test('parseDoc preserves a per-file seek map through the sync validator', () => {
  const raw = {
    v: 1,
    readalong: {
      h: {
        updated: 1,
        value: {
          epub: { hash: 'e', fileId: 1, title: 't', paragraphs: 1, paragraphsSha1: 's' },
          files: [{ id: 1, duration: 10, anchors: [[1, 0, 0]], seek: DUNE }],
          timing: 2,
          created: 5,
        },
      },
    },
  };
  const doc = parseDoc(raw);
  const rec = doc.readalong['h'].value as { files: { seek?: XingSeekMap }[] };
  assert.ok(rec.files[0].seek);
  assert.equal(rec.files[0].seek!.kind, 'xing');
  assert.equal(rec.files[0].seek!.toc.length, 100);
});

test('trueToSeekTarget inverts the landing time and clamps', () => {
  const m = smallMap();
  for (const X of [0.5, 1.25, 2, 3.9]) {
    const T = trueToSeekTarget(m, X);
    const back = playerToTrue(m, T, T);
    assert.ok(Math.abs(back - X) < 0.05, `X=${X} back=${back}`);
  }
  assert.equal(trueToSeekTarget(m, -100), 0);
  assert.equal(trueToSeekTarget(m, 1e9), m.durationUs / 1e6);
});

// ---- ffmpeg model (Chromium/libavformat with AVFMT_FLAG_FAST_SEEK) ----
//
// A synthetic map where the arithmetic is exact: 100 s long, 25600 bytes of data, and a true-time
// table linear in the byte, so `trueTimeAtByte(b) = b/256`. A TOC entry `toc[i]` then seeks to
// byte `toc[i]*100` and reports `timestamp_i = i` s, giving `err_i = toc[i]*0.390625 - i`.

const FFMPEG_DATA_SIZE = 25601; // framePosition 0 + dataSize - 1 = tableEndByte 25600

/** A 100 s ffmpeg map with the given 100-entry TOC and `trueTimeAtByte(b) = b/256`. */
function ffmpegMap(toc: number[]): XingSeekMap {
  return {
    v: 1, kind: 'xing',
    xingFramePosition: 0, xingFrameSize: 0, dataStartPosition: 0,
    dataSize: FFMPEG_DATA_SIZE, durationUs: 100_000_000, toc,
    tableStartByte: 0, tableEndByte: 25600, intervals: 100,
    t0cs: 0, deltaCs: new Array(100).fill(100),
  };
}

/** toc[i] = round(i*2.56): byte_i ~= i*100 bytes, so err_i ~= 0 and the landing is near-linear. */
const linearToc = Array.from({ length: 100 }, (_, i) => Math.round(i * 2.56));

/** err jumps up at the 21st slot: slots 0..20 are near-exact, 21..99 pin the TOC at its maximum. */
const jumpToc = linearToc.map((v, i) => (i >= 21 ? 255 : v));

/** The true time a seek to T lands on, read back through the app's conversion. */
const landFfmpeg = (m: XingSeekMap, T: number) => playerToTrue(m, T, T, 'ffmpeg');

test('ffmpegSeekSlot picks the last TOC slot at or before T, clamped', () => {
  const m = ffmpegMap(linearToc);
  assert.equal(ffmpegSeekSlot(m, 0), 0);
  assert.equal(ffmpegSeekSlot(m, -5), 0);
  assert.equal(ffmpegSeekSlot(m, 0.999), 0);
  assert.equal(ffmpegSeekSlot(m, 1), 1); // exactly at the boundary it takes the next slot
  assert.equal(ffmpegSeekSlot(m, 1.001), 1);
  assert.equal(ffmpegSeekSlot(m, 50 - 1e-9), 49);
  assert.equal(ffmpegSeekSlot(m, 99.999), 99);
  assert.equal(ffmpegSeekSlot(m, 100), 99);
  assert.equal(ffmpegSeekSlot(m, 1e9), 99);
});

test('ffmpegSeekByte, ffmpegSlotTimestamp and ffmpegSlotError match the ffmpeg arithmetic', () => {
  const m = ffmpegMap(linearToc);
  for (const i of [0, 1, 20, 50, 99]) {
    assert.equal(ffmpegSeekByte(m, i), m.xingFramePosition + Math.floor((m.toc[i] * m.dataSize) / 256));
    assert.equal(ffmpegSlotTimestamp(m, i), i); // duration 100 s
    assert.ok(Math.abs(ffmpegSlotError(m, i) - (m.toc[i] * 0.390625 - i)) < 1e-9);
  }
});

test('the ffmpeg error is constant across a slot, so the offset only changes at boundaries', () => {
  const m = ffmpegMap(linearToc);
  const err = ffmpegSlotError(m, 30);
  for (const T of [30, 30.25, 30.9]) {
    assert.equal(ffmpegSeekSlot(m, T), 30);
    assert.ok(Math.abs((playerToTrue(m, T, T, 'ffmpeg') - T) - err) < 1e-9, `T=${T}`);
    // The reported time keeps the same offset when it advances within the slot.
    assert.ok(Math.abs((playerToTrue(m, T, T + 5, 'ffmpeg') - (T + 5)) - err) < 1e-9);
  }
  assert.notEqual(ffmpegSlotError(m, 29), err);
});

test('the ffmpeg model handles T=0 and T=duration', () => {
  const m = ffmpegMap(linearToc);
  assert.equal(ffmpegSlotError(m, 0), 0);
  assert.ok(Math.abs(playerToTrue(m, 0, 0, 'ffmpeg') - 0) < 1e-9);
  assert.ok(Math.abs(playerToTrue(m, 100, 100, 'ffmpeg') - (100 + ffmpegSlotError(m, 99))) < 1e-9);
  // The media3 model is untouched by the new one.
  assert.ok(Math.abs(playerToTrue(m, 100, 100, 'media3') - trueTimeAtByte(m, seekByte(m, 100))) < 1e-9);
});

test('trueToSeekTarget with the ffmpeg model round-trips where a valid candidate exists', () => {
  const m = ffmpegMap(linearToc);
  for (let i = 0; i < 100; i++) {
    const X = i + 0.5;
    const T = trueToSeekTarget(m, X, 'ffmpeg');
    assert.equal(ffmpegSeekSlot(m, T), i, `X=${X}`);
    assert.ok(Math.abs(landFfmpeg(m, T) - X) < 1e-6, `X=${X} landed=${landFfmpeg(m, T)}`);
  }
  // Clamped at the file's ends (the exact far end is unreachable, so it lands just before it).
  assert.equal(trueToSeekTarget(m, -100, 'ffmpeg'), 0);
  assert.ok(Math.abs(trueToSeekTarget(m, 1e9, 'ffmpeg') - 100) < 0.01);
});

test('trueToSeekTarget with the ffmpeg model picks the nearest boundary when X is unreachable', () => {
  const m = ffmpegMap(jumpToc);
  const err20 = ffmpegSlotError(m, 20);
  const err21 = ffmpegSlotError(m, 21);
  // The landing jumps from ~20.9 s (end of slot 20) to ~99.6 s (start of slot 21): a wide gap.
  const left = 21 + err20;
  const right = 21 + err21;
  assert.ok(right - left > 70, `gap ${left}..${right}`);
  // A wanted time in the gap with no valid candidate: land at the nearer edge.
  const before = trueToSeekTargetFfmpeg(m, 50);
  assert.ok(landFfmpeg(m, before) <= 50 + 1e-6);
  assert.ok(Math.abs(landFfmpeg(m, before) - left) < 0.01);
  assert.equal(ffmpegSeekSlot(m, before), 20);
  // Nearer to the right edge, it lands just after the requested time instead.
  const after = trueToSeekTargetFfmpeg(m, 90);
  assert.ok(landFfmpeg(m, after) > 90);
  assert.ok(Math.abs(landFfmpeg(m, after) - right) < 0.01);
  assert.equal(ffmpegSeekSlot(m, after), 21);
});
