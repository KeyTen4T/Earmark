import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewindFor, rewindPosition, REWIND_MIN_PAUSE_MS } from '../src/player/rewind';

// The rewind-after-pause rule is pure: how far back to jump by how long playback was paused.
// Boundaries are `< 5 s`, `< 1 min`, `< 5 min`, `< 1 h`, else.

test('rewindFor: under five seconds is no rewind', () => {
  assert.equal(rewindFor(0), 0);
  assert.equal(rewindFor(1_234), 0);
  assert.equal(rewindFor(REWIND_MIN_PAUSE_MS - 1), 0);
});

test('rewindFor: the pause length picks the step', () => {
  assert.equal(rewindFor(REWIND_MIN_PAUSE_MS), 2); // exactly 5 s counts
  assert.equal(rewindFor(59_999), 2);
  assert.equal(rewindFor(60_000), 5); // exactly 1 min
  assert.equal(rewindFor(5 * 60_000 - 1), 5);
  assert.equal(rewindFor(5 * 60_000), 10); // exactly 5 min
  assert.equal(rewindFor(60 * 60_000 - 1), 10);
  assert.equal(rewindFor(60 * 60_000), 20); // exactly 1 h
  assert.equal(rewindFor(9 * 60 * 60_000), 20);
});

test('rewindFor: a missing or nonsensical pause is no rewind', () => {
  assert.equal(rewindFor(-1), 0);
  assert.equal(rewindFor(NaN), 0);
  assert.equal(rewindFor(Infinity), 20); // an implausibly long pause still rewinds the most
});

test('rewindPosition: jumps back but never before the start of the file', () => {
  assert.equal(rewindPosition(100, 0), 100); // no pause, stays put
  assert.equal(rewindPosition(100, 30_000), 98); // < 1 min → 2 s
  assert.equal(rewindPosition(100, 10 * 60_000), 90); // 5 min–1 h → 10 s
  assert.equal(rewindPosition(100, 2 * 60 * 60_000), 80); // ≥ 1 h → 20 s
  assert.equal(rewindPosition(3, 60 * 60_000), 0); // clamped at the chapter start
  assert.equal(rewindPosition(0, 30_000), 0);
});
