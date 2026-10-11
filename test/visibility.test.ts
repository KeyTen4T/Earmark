import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldPushUpdate, shouldAnimateProgress, TICK_FIELDS, PROGRESS_ANIMATE_EPSILON,
} from '../src/player/visibility';

test('visibility: everything is pushed while the app is active', () => {
  for (const keys of [['position'], ['playing'], ['index'], ['error'], ['sleep'], []]) {
    assert.equal(shouldPushUpdate(true, keys), true, JSON.stringify(keys));
  }
});

test('visibility: tick fields are held back while the app is not active', () => {
  for (const k of TICK_FIELDS) {
    assert.equal(shouldPushUpdate(false, [k]), false, k);
  }
  assert.equal(shouldPushUpdate(false, ['position', 'duration', 'playing']), false);
});

test('visibility: a change the user must see is pushed even in the background', () => {
  assert.equal(shouldPushUpdate(false, ['index']), true);
  assert.equal(shouldPushUpdate(false, ['error']), true);
  assert.equal(shouldPushUpdate(false, ['sleep']), true);
  assert.equal(shouldPushUpdate(false, ['book']), true);
  assert.equal(shouldPushUpdate(false, ['position', 'index']), true);
});

test('visibility: small progress moves are set directly, real jumps animate', () => {
  assert.equal(shouldAnimateProgress(0.4, 0.4 + PROGRESS_ANIMATE_EPSILON / 2), false);
  assert.equal(shouldAnimateProgress(0.4, 0.404), false);
  assert.equal(shouldAnimateProgress(0.4, 0.41), true);
  assert.equal(shouldAnimateProgress(0, 1), true);
});

test('visibility: progress values are clamped and NaN is treated as empty', () => {
  assert.equal(shouldAnimateProgress(0, -1), false);
  assert.equal(shouldAnimateProgress(1, 2), false);
  assert.equal(shouldAnimateProgress(NaN, 0), false);
  assert.equal(shouldAnimateProgress(0, NaN), false);
  assert.equal(shouldAnimateProgress(0.5, NaN), true); // NaN clamps to 0, a real jump
});
