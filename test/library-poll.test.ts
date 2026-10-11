import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADD_BLIND_MS, ADD_WAIT_MS, NOT_WAITING, awaitAdded, settleAwaited, stillWaiting } from '../src/library-poll';

test('library poll: a known book is waited for until it is listed', () => {
  let a = awaitAdded(NOT_WAITING, 'ABC', 1000);
  assert.deepEqual(a, { hashes: ['abc'], until: 1000 + ADD_WAIT_MS });
  a = settleAwaited(a, ['zzz'], 2000);
  assert.ok(stillWaiting(a, 2000));
  a = settleAwaited(a, ['zzz', 'Abc'], 3000);
  assert.equal(stillWaiting(a, 3000), false);
});

test('library poll: the wait gives up when its time is over', () => {
  const a = awaitAdded(NOT_WAITING, 'abc', 0);
  assert.equal(stillWaiting(settleAwaited(a, [], ADD_WAIT_MS), ADD_WAIT_MS), false);
});

test('library poll: an add with no hash re-reads for a short while', () => {
  const a = awaitAdded(NOT_WAITING, undefined, 0);
  assert.ok(stillWaiting(settleAwaited(a, ['x'], 1000), 1000));
  assert.equal(stillWaiting(settleAwaited(a, ['x'], ADD_BLIND_MS), ADD_BLIND_MS), false);
});

test('library poll: two adds are both waited for, and the same hash is not doubled', () => {
  let a = awaitAdded(awaitAdded(NOT_WAITING, 'a', 0), 'b', 10);
  a = awaitAdded(a, 'A', 20);
  assert.deepEqual(a.hashes, ['a', 'b']);
  a = settleAwaited(a, ['a'], 30);
  assert.deepEqual(a.hashes, ['b']);
});
