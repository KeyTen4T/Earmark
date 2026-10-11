import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extrapolatePosition, MAX_EXTRAPOLATION_SECONDS, type PositionClock } from '../src/player/position';

const clock = (over: Partial<PositionClock> = {}): PositionClock => ({
  position: 100,
  at: 0,
  rate: 1,
  playing: true,
  loading: false,
  recovering: false,
  seekPending: false,
  ...over,
});

test('extrapolatePosition adds elapsed time times the rate while playing', () => {
  assert.equal(extrapolatePosition(clock(), 1000), 101);
  assert.equal(extrapolatePosition(clock({ rate: 2 }), 500), 101); // 0.5 s * 2, under the cap
  assert.equal(extrapolatePosition(clock({ rate: 0.5 }), 2000), 101);
});

test('extrapolatePosition is capped so a stale report cannot run away', () => {
  const capped = extrapolatePosition(clock(), 60_000);
  assert.equal(capped, 100 + MAX_EXTRAPOLATION_SECONDS);
  assert.equal(extrapolatePosition(clock({ rate: 3 }), 1000), 100 + MAX_EXTRAPOLATION_SECONDS);
});

test('extrapolatePosition never moves while paused, loading, recovering or seeking', () => {
  for (const over of [
    { playing: false }, { loading: true }, { recovering: true }, { seekPending: true },
  ]) {
    assert.equal(extrapolatePosition(clock(over), 5000), 100, JSON.stringify(over));
  }
});

test('extrapolatePosition ignores a non-positive elapsed time', () => {
  assert.equal(extrapolatePosition(clock(), 0), 100);
  assert.equal(extrapolatePosition(clock(), -50), 100);
});

test('extrapolatePosition returns the last position exactly at the report time', () => {
  assert.equal(extrapolatePosition(clock({ rate: 1.25 }), 0), 100);
});
