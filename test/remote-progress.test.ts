import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldApplyRemoteProgress } from '../src/remote-progress';

test('remote progress: applies when there is no local record', () => {
  assert.equal(shouldApplyRemoteProgress(undefined, { updated: 5 }), true);
});

test('remote progress: applies when the incoming record is newer or the same age', () => {
  assert.equal(shouldApplyRemoteProgress({ updated: 1 }, { updated: 2 }), true);
  assert.equal(shouldApplyRemoteProgress({ updated: 3 }, { updated: 3 }), true);
});

test('remote progress: skips an incoming record the local one has outlived', () => {
  assert.equal(shouldApplyRemoteProgress({ updated: 10 }, { updated: 4 }), false);
});
