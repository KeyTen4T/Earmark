// Pure Xing seek map: translate between the time a player reports and the true audio time for a
// VBR MP3 whose first frame carries a Xing tag with a TOC. No react-native/expo/node imports, so
// it runs under the plain Node test runner and on device.
//
// Why this exists: a player seeks with the coarse 1/256 TOC, lands on a byte that is not where the
// wanted audio lives, and reports a time that does not match the audio it actually plays. On a real
// VBR file the highlight can then run seconds to minutes from the narrator. The tool emits the exact
// `seek` map (see tools/readalong/readalong.py); this module applies the player's seek model to
// recover the true audio time, and inverts it to pick a seek target that lands on a wanted time.
//
// Two players are modelled, chosen with `SeekModel`:
//   - 'media3' (Android, expo-audio): XingSeeker.getSeekPoints(T) picks a byte by interpolating the
//     TOC, and the first frame it lands on is timestamped with XingSeeker.getTimeUs(byte) (the TOC
//     inverse) while samples before T are dropped.
//   - 'ffmpeg' (Chromium/web, libavformat with AVFMT_FLAG_FAST_SEEK): read_xing_toc builds 100 index
//     entries byte_i = xingFramePosition + floor(toc[i]*dataSize/256) at timestamp_i = i*duration/100;
//     mp3_seek picks the last entry at or before T, syncs forward to the next frame, labels it
//     timestamp_i, and the decoder drops audio up to T.

/** A per-file `seek` object emitted by the tool for a Xing/VBR MP3. */
export type XingSeekMap = {
  v: number;
  kind: string;
  /** Start of the Xing frame (media3's `XingSeeker` `dataStartPosition` constructor argument). */
  xingFramePosition: number;
  /** Byte size of the Xing frame itself. */
  xingFrameSize: number;
  /** First audio frame = `xingFramePosition + xingFrameSize` (media3 `getDataStartPosition()`). */
  dataStartPosition: number;
  /** The Xing `dataSize` field (bytes from the Xing frame to the end of the audio). */
  dataSize: number;
  /** media3's `XingFrame.computeDurationUs()`, in microseconds. */
  durationUs: number;
  /** The 100 table-of-contents bytes (0..255). */
  toc: number[];
  /** First byte covered by the true-time table (same as `dataStartPosition`). */
  tableStartByte: number;
  /** Last byte covered by the true-time table (inclusive). */
  tableEndByte: number;
  /** Number of equal byte intervals in the table (`deltaCs.length`). */
  intervals: number;
  /** True time at `tableStartByte`, in centiseconds. */
  t0cs: number;
  /** `time[i+1] - time[i]` in centiseconds, so times are reconstructed by a running sum. */
  deltaCs: number[];
};

const TOC_LEN = 100;

const isFiniteNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => isFiniteNum(x) && Number.isInteger(x);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Validate a raw `seek` object. Returns null for anything malformed, or an unknown `v`/`kind`, so
 * a stale or hand-edited record simply falls back to no correction.
 */
export function decodeSeekMap(raw: unknown): XingSeekMap | null {
  if (!isObj(raw) || raw.v !== 1 || raw.kind !== 'xing') return null;
  const toc = raw.toc;
  const deltaCs = raw.deltaCs;
  if (!Array.isArray(toc) || toc.length !== TOC_LEN || !toc.every((b) => isInt(b) && b >= 0 && b <= 255)) return null;
  if (!Array.isArray(deltaCs) || deltaCs.length === 0 || !deltaCs.every((d) => isInt(d) && d >= 0)) return null;
  const intervals = raw.intervals;
  if (!isInt(intervals) || intervals !== deltaCs.length) return null;
  if (!isInt(raw.xingFramePosition) || raw.xingFramePosition < 0) return null;
  if (!isInt(raw.xingFrameSize) || raw.xingFrameSize < 0) return null;
  if (!isInt(raw.dataStartPosition) || !isInt(raw.dataSize) || raw.dataSize <= 0) return null;
  if (!isInt(raw.durationUs) || raw.durationUs <= 0) return null;
  if (!isInt(raw.tableStartByte) || !isInt(raw.tableEndByte) || raw.tableEndByte <= raw.tableStartByte) return null;
  if (!isInt(raw.t0cs)) return null;
  return {
    v: 1,
    kind: 'xing',
    xingFramePosition: raw.xingFramePosition,
    xingFrameSize: raw.xingFrameSize,
    dataStartPosition: raw.dataStartPosition,
    dataSize: raw.dataSize,
    durationUs: raw.durationUs,
    toc: toc as number[],
    tableStartByte: raw.tableStartByte,
    tableEndByte: raw.tableEndByte,
    intervals,
    t0cs: raw.t0cs,
    deltaCs: deltaCs as number[],
  };
}

// Running-sum of deltaCs, cached per map object. Behaviour is pure; the cache only avoids an
// O(intervals) sum on every lookup.
const CUM_CS = new WeakMap<XingSeekMap, Float64Array>();
function timesCs(map: XingSeekMap): Float64Array {
  let t = CUM_CS.get(map);
  if (!t) {
    t = new Float64Array(map.intervals + 1);
    let acc = map.t0cs;
    t[0] = acc;
    for (let i = 0; i < map.intervals; i++) t[i + 1] = (acc += map.deltaCs[i]);
    CUM_CS.set(map, t);
  }
  return t;
}

/**
 * The byte media3 starts reading at for a seek to `T` seconds: a faithful port of
 * `androidx.media3.extractor.mp3.XingSeeker.getSeekPoints(long)` (media3 1.9.0). The returned byte
 * is the Xing-frame base plus a clamped offset, and is generally not a frame boundary.
 */
export function seekByte(map: XingSeekMap, T: number): number {
  const timeUs = clamp(Math.round(T * 1e6), 0, map.durationUs);
  const percent = (timeUs * 100) / map.durationUs;
  let scaled: number;
  if (percent <= 0) {
    scaled = 0;
  } else if (percent >= 100) {
    scaled = 256;
  } else {
    const prevIndex = Math.trunc(percent); // Java (int) cast truncates toward zero
    const prev = map.toc[prevIndex];
    const next = prevIndex === TOC_LEN - 1 ? 256 : map.toc[prevIndex + 1];
    scaled = prev + (percent - prevIndex) * (next - prev);
  }
  const offset = clamp(Math.round((scaled / 256) * map.dataSize), map.xingFrameSize, map.dataSize - 1);
  return map.xingFramePosition + offset;
}

/** True start time (seconds) of the first frame at or after `byte`, linearly interpolated. */
export function trueTimeAtByte(map: XingSeekMap, byte: number): number {
  const span = map.tableEndByte - map.tableStartByte;
  const b = clamp(byte, map.tableStartByte, map.tableEndByte);
  const f = span > 0 ? ((b - map.tableStartByte) / span) * map.intervals : 0;
  const i = clamp(Math.floor(f), 0, map.intervals - 1);
  const frac = f - i;
  const t = timesCs(map);
  return (t[i] + frac * (t[i + 1] - t[i])) / 100;
}

/** Which demuxer/player's seek arithmetic to model. */
export type SeekModel = 'media3' | 'ffmpeg';

/** ffmpeg's Xing TOC index has 100 entries (`XING_TOC_COUNT`). */
const FFMPEG_TOC_COUNT = 100;

/**
 * The ffmpeg TOC slot a seek to `T` lands in: the last entry with `timestamp_i <= T`, i.e.
 * `floor(T * 100 / duration)` clamped to 0..99.
 */
export function ffmpegSeekSlot(map: XingSeekMap, T: number): number {
  const durationSec = map.durationUs / 1e6;
  const i = durationSec > 0 ? Math.floor((T * FFMPEG_TOC_COUNT) / durationSec) : 0;
  return clamp(i, 0, FFMPEG_TOC_COUNT - 1);
}

/**
 * The byte ffmpeg seeks to for TOC slot `i`: `xingFramePosition + floor(toc[i] * dataSize / 256)`
 * (`read_xing_toc`'s index entry, before `mp3_sync` nudges it forward to a frame boundary).
 */
export function ffmpegSeekByte(map: XingSeekMap, i: number): number {
  const slot = clamp(Math.floor(i), 0, FFMPEG_TOC_COUNT - 1);
  return map.xingFramePosition + Math.floor((map.toc[slot] * map.dataSize) / 256);
}

/** The timestamp ffmpeg labels slot `i` with: `i * duration / 100` seconds. */
export function ffmpegSlotTimestamp(map: XingSeekMap, i: number): number {
  const slot = clamp(Math.floor(i), 0, FFMPEG_TOC_COUNT - 1);
  return (slot * (map.durationUs / 1e6)) / FFMPEG_TOC_COUNT;
}

/**
 * The steady error of an ffmpeg TOC seek in slot `i`: the true time of the frame it lands on minus
 * the timestamp it reports there, `trueTimeAtByte(byte_i) - timestamp_i`. It is constant for every
 * seek target in the slot and changes (jumps) at each slot boundary.
 */
export function ffmpegSlotError(map: XingSeekMap, i: number): number {
  return trueTimeAtByte(map, ffmpegSeekByte(map, i)) - ffmpegSlotTimestamp(map, i);
}

/** The true time a player lands on for a seek to `T`, under `model`. */
function landing(map: XingSeekMap, T: number, model: SeekModel): number {
  if (model === 'ffmpeg') return T + ffmpegSlotError(map, ffmpegSeekSlot(map, T));
  return trueTimeAtByte(map, seekByte(map, T));
}

/**
 * The player model: after seeking to `seekTarget` seconds the player reports `reported` seconds,
 * and the audio actually playing is at true time `reported + (landing(seekTarget) - seekTarget)`,
 * where `landing(T)` is the true time the seek lands on. With no seek (`seekTarget` null/undefined)
 * the player and the audio share a clock, so the reported time is already true.
 */
export function playerToTrue(
  map: XingSeekMap,
  seekTarget: number | null | undefined,
  reported: number,
  model: SeekModel = 'media3',
): number {
  if (seekTarget == null) return reported;
  return reported + (landing(map, seekTarget, model) - seekTarget);
}

/**
 * The seek target to pass to the player so playback starts at `trueTime`. For media3 the monotonic
 * `landing(T)` is inverted by bisection. For ffmpeg `landing` is not monotonic across slot
 * boundaries, so each slot's exact candidate `T = trueTime - err_i` is tried and the result clamped
 * to the file (see {@link trueToSeekTargetFfmpeg}).
 */
export function trueToSeekTarget(map: XingSeekMap, trueTime: number, model: SeekModel = 'media3'): number {
  if (model === 'ffmpeg') return trueToSeekTargetFfmpeg(map, trueTime);
  const durationSec = map.durationUs / 1e6;
  const land = (T: number) => trueTimeAtByte(map, seekByte(map, T));
  if (trueTime <= land(0)) return 0;
  if (trueTime >= land(durationSec)) return durationSec;
  let lo = 0;
  let hi = durationSec;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (land(mid) < trueTime) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Invert the ffmpeg landing for a wanted `trueTime`. `landing(T) = T + err_i` is exact within a slot,
 * so the candidate for slot `i` is `T = trueTime - err_i`, valid when it falls inside that slot's
 * `[timestamp_i, timestamp_{i+1})` range; any valid candidate is exact, and the smallest is taken.
 *
 * When none is valid the wanted time fell in a gap where `err` jumps up at a slot boundary (so some
 * true times are unreachable). Then the boundary landing closest to `trueTime` is chosen, preferring
 * to land just before it rather than after.
 */
export function trueToSeekTargetFfmpeg(map: XingSeekMap, trueTime: number): number {
  const durationSec = map.durationUs / 1e6;
  const X = clamp(trueTime, 0, durationSec);

  let best: number | null = null;
  for (let i = 0; i < FFMPEG_TOC_COUNT; i++) {
    const T = X - ffmpegSlotError(map, i);
    if (T < 0 || T > durationSec) continue;
    if (ffmpegSeekSlot(map, T) !== i) continue;
    if (best == null || T < best) best = T;
  }
  if (best != null) return best;

  let bestT = 0;
  let bestDist = Infinity;
  let bestBefore = false; // the best-so-far landing is <= X
  const consider = (landingValue: number, T: number) => {
    const dist = Math.abs(landingValue - X);
    const before = landingValue <= X;
    const better = dist < bestDist - 1e-9
      || (Math.abs(dist - bestDist) <= 1e-9 && before && !bestBefore);
    if (better) { bestDist = dist; bestT = T; bestBefore = before; }
  };
  for (let i = 0; i < FFMPEG_TOC_COUNT; i++) {
    const start = ffmpegSlotTimestamp(map, i);
    const err = ffmpegSlotError(map, i);
    const end = i === FFMPEG_TOC_COUNT - 1 ? durationSec : ffmpegSlotTimestamp(map, i + 1);
    consider(start + err, start); // entering the slot
    consider(end + err, Math.max(0, end - 1e-6)); // leaving the slot, just inside it
  }
  return clamp(bestT, 0, durationSec);
}
