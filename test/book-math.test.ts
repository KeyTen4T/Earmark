import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeWeightedFraction, estimateBookSeconds, remainingBookSeconds } from '../src/book-math';

test('book-math: size-weighted fraction, with an equal-weight fallback', () => {
  const sizes = [100, 600, 300];
  // half way through the big middle chapter: (100 + 0.5*600) / 1000
  assert.equal(sizeWeightedFraction(sizes, 1, 300, 600, 3), 0.4);
  // a finished book is always complete
  assert.equal(sizeWeightedFraction(sizes, 1, 300, 600, 3, true), 1);
  // no sizes -> every chapter counts the same, matching the old bookFraction
  assert.equal(sizeWeightedFraction(undefined, 1, 300, 600, 3), (1 + 0.5) / 3);
  // nothing to measure
  assert.equal(sizeWeightedFraction(sizes, 0, 0, 0, 0), 0);
});

test('book-math: whole-book runtime estimated from the current file', () => {
  const sizes = [100, 600, 300];
  // the current file is 600s for 600 bytes, so 1000 bytes in total is 1000s
  assert.equal(estimateBookSeconds(sizes, 1, 600), 1000);
  assert.equal(estimateBookSeconds(sizes, 1, 0), null);
  assert.equal(estimateBookSeconds(undefined, 1, 600), null);
  assert.equal(estimateBookSeconds([100, 0, 300], 1, 600), null);
});

test('book-math: remaining time follows the size-weighted position', () => {
  const sizes = [100, 600, 300];
  // 40% done of a 1000s book -> 600s left
  assert.equal(remainingBookSeconds(sizes, 1, 300, 600, 3), 600);
  assert.equal(remainingBookSeconds(sizes, 1, 300, 600, 3, true), 0);
  // no sizes -> no estimate
  assert.equal(remainingBookSeconds(undefined, 1, 300, 600, 3), null);
});
