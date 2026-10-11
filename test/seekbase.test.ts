import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectJump, seekSettled, readalongTime, readalongSeekTarget, JUMP_THRESHOLD_SECONDS, SEEK_SETTLE_MS,
  type JumpState,
} from '../src/player/seekbase';
import { seekByte, trueTimeAtByte, playerToTrue, type XingSeekMap } from '../src/readalong/mp3seek';
import { extrapolatePosition, type PositionClock } from '../src/player/position';

const jump = (over: Partial<JumpState> = {}): JumpState => ({
  position: 100, at: 0, rate: 1, playing: true, seekPending: false, ...over,
});

test('detectJump ignores normal playback and sub-threshold drift', () => {
  assert.equal(detectJump(jump(), 101, 1000).jumped, false);
  assert.equal(detectJump(jump(), 101.4, 1000).jumped, false); // 0.4 s ahead, under the threshold
  assert.equal(detectJump(jump(), 100 + JUMP_THRESHOLD_SECONDS - 0.01, 0).jumped, false);
});

test('detectJump flags a jump and returns the newly reported position', () => {
  const j = detectJump(jump(), 130, 1000); // expected 101
  assert.equal(j.jumped, true);
  assert.equal(j.target, 130);
  assert.equal(detectJump(jump(), 70, 1000).jumped, true); // a backward jump too
});

test('detectJump scales the expectation by the playback rate', () => {
  assert.equal(detectJump(jump({ rate: 2 }), 102, 1000).jumped, false); // expected 102
  assert.equal(detectJump(jump({ rate: 2 }), 104, 1000).jumped, true);
});

test('detectJump does not mistake a stall for a seek', () => {
  // 20 s of wall time passed but the stream only advanced 2 s: behind the clock, not a jump.
  assert.equal(detectJump(jump(), 102, 20_000).jumped, false);
  assert.equal(detectJump(jump(), 100, 20_000).jumped, false);
  // Going backwards, or further than the elapsed time allows, still is one.
  assert.equal(detectJump(jump(), 95, 20_000).jumped, true);
  assert.equal(detectJump(jump(), 125, 20_000).jumped, true);
});

test('detectJump holds the position while paused', () => {
  assert.equal(detectJump(jump({ playing: false }), 100, 10_000).jumped, false);
  assert.equal(detectJump(jump({ playing: false }), 120, 10_000).jumped, true);
});

test('detectJump never re-reads a pending JS seek', () => {
  // The JS path already recorded the target; a big reported position must not overwrite it.
  const j = detectJump(jump({ seekPending: true }), 500, 1000);
  assert.equal(j.jumped, false);
  assert.equal(j.target, 500);
});

test('seekSettled waits for a seek to land, then gives up', () => {
  // Asked for 49775 s; the source still reports 0 while it loads: not landed.
  assert.equal(seekSettled(49775, 0, 0, 500, 1), false);
  // Landed, and a couple of seconds of playback later.
  assert.equal(seekSettled(49775, 0, 49775, 600, 1), true);
  assert.equal(seekSettled(49775, 0, 49777, 2000, 1), true);
  // Somewhere else entirely is not our seek landing...
  assert.equal(seekSettled(49775, 0, 51000, 2000, 1), false);
  // ...but detection is never switched off for good.
  assert.equal(seekSettled(49775, 0, 0, SEEK_SETTLE_MS + 1, 1), true);
});

// A small synthetic map whose table is exact (same shape as test/mp3seek.test.ts).
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

test('readalongTime is a no-op without a map, without a model, or with no seek', () => {
  const m = smallMap();
  assert.equal(readalongTime(null, 'media3', 2, 50), 50);
  assert.equal(readalongTime(m, null, 2, 50), 50);
  assert.equal(readalongTime(m, undefined, 2, 50), 50);
  assert.equal(readalongTime(m, 'media3', null, 50), 50);
  assert.equal(readalongTime(m, 'media3', undefined, 50), 50);
});

test('readalongTime applies the seek landing offset with the media3 model', () => {
  const m = smallMap();
  const landing = trueTimeAtByte(m, seekByte(m, 2));
  assert.ok(Math.abs(readalongTime(m, 'media3', 2, 2) - landing) < 1e-9);
  assert.ok(Math.abs(readalongTime(m, 'media3', 2, 10) - (landing + 8)) < 1e-9);
});

test('readalongSeekTarget is a no-op without a map or without a model', () => {
  const m = smallMap();
  assert.equal(readalongSeekTarget(null, 'media3', 2), 2);
  assert.equal(readalongSeekTarget(m, null, 2), 2);
  assert.equal(readalongSeekTarget(m, undefined, 2), 2);
});

test('readalongSeekTarget inverts readalongTime with the media3 model', () => {
  const m = smallMap();
  for (const X of [0.5, 1.25, 2, 3.9]) {
    const T = readalongSeekTarget(m, 'media3', X);
    assert.ok(Math.abs(readalongTime(m, 'media3', T, T) - X) < 0.05, `X=${X}`);
  }
});

test('readalongTime and readalongSeekTarget thread the ffmpeg model through', () => {
  const m = smallMap();
  // The boundary conversion equals the raw ffmpeg conversion...
  assert.ok(Math.abs(readalongTime(m, 'ffmpeg', 2, 5) - playerToTrue(m, 2, 5, 'ffmpeg')) < 1e-9);
  // ...and a tap seeks to the target that lands on the wanted true time.
  const T = readalongSeekTarget(m, 'ffmpeg', 2);
  assert.ok(Math.abs(readalongTime(m, 'ffmpeg', T, T) - 2) < 0.05);
});

test('the seek offset is constant, so converting the base clock composes with extrapolation', () => {
  const m = smallMap();
  const clock: PositionClock = {
    position: readalongTime(m, 'media3', 2, 2.3), at: 0, rate: 1,
    playing: true, loading: false, recovering: false, seekPending: false,
  };
  // One second of playback: extrapolating the converted base equals converting the extrapolated base.
  assert.ok(Math.abs(extrapolatePosition(clock, 1000) - readalongTime(m, 'media3', 2, 3.3)) < 1e-9);
});
