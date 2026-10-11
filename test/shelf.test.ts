import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookFinishedAt, clampRating, formatFinishedDate, normalizeRating, ratingAfterTap, shelfGroups,
} from '../src/shelf';

// Dates are built from local components so the assertions hold whatever timezone the runner is in.
const at = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

test('shelf: a rating is clamped and rounded to half steps', () => {
  assert.equal(clampRating(3.24), 3);
  assert.equal(clampRating(3.26), 3.5);
  assert.equal(clampRating(0.1), 0.5);
  assert.equal(clampRating(9), 5);
  assert.equal(normalizeRating(undefined), undefined);
  assert.equal(normalizeRating(null), undefined);
  assert.equal(normalizeRating(NaN), undefined);
  assert.equal(normalizeRating(0.25), undefined);
  assert.equal(normalizeRating(4.5), 4.5);
  assert.equal(normalizeRating(4.4), 4.5);
  assert.equal(normalizeRating(7), 5);
});

test('shelf: tapping a star follows the whole/half/clear rule', () => {
  assert.equal(ratingAfterTap(undefined, 4), 4);
  assert.equal(ratingAfterTap(2, 4), 4);
  assert.equal(ratingAfterTap(4, 4), 3.5);
  assert.equal(ratingAfterTap(3.5, 4), 4);
  // A star below the current rating simply moves the rating down to that star.
  assert.equal(ratingAfterTap(3.5, 3), 3);
  // The first star is the only one that can reach a clear.
  assert.equal(ratingAfterTap(1, 1), 0.5);
  assert.equal(ratingAfterTap(0.5, 1), undefined);
  // Out-of-range star numbers are pulled into 1..5.
  assert.equal(ratingAfterTap(undefined, 0), 1);
  assert.equal(ratingAfterTap(undefined, 9), 5);
});

test('shelf: a finish date is the day and short month, blank when undated', () => {
  assert.equal(formatFinishedDate(at(2026, 9, 3)), '3 Oct');
  assert.equal(formatFinishedDate(at(2025, 0, 31)), '31 Jan');
  assert.equal(formatFinishedDate(undefined), '');
  assert.equal(formatFinishedDate(0), '');
});

test('shelf: an undated finished book falls back to the progress timestamp', () => {
  assert.equal(bookFinishedAt(undefined, { finished: true, updated: 123 }), 123);
  assert.equal(bookFinishedAt({ finishedAt: 900 }, { finished: true, updated: 123 }), 900);
  assert.equal(bookFinishedAt({ finishedAt: 0 }, { finished: true, updated: 123 }), 123);
  assert.equal(bookFinishedAt(undefined, { finished: false, updated: 123 }), undefined);
  assert.equal(bookFinishedAt(undefined, undefined), undefined);
});

test('shelf: books group by year, newest first, undated last', () => {
  const groups = shelfGroups([
    { id: 1, finishedAt: at(2025, 4, 1) },
    { id: 2, finishedAt: at(2026, 9, 3) },
    { id: 3, finishedAt: at(2026, 0, 12) },
    { id: 4 },
    { id: 5, finishedAt: at(2024, 11, 31) },
  ]);
  assert.deepEqual(groups.map((g) => [g.year, g.count, g.books.map((b) => b.id)]), [
    [2026, 2, [2, 3]],
    [2025, 1, [1]],
    [2024, 1, [5]],
    [null, 1, [4]],
  ]);
  assert.equal(groups[0].label, '2026 · 2 books');
  assert.equal(groups[1].label, '2025 · 1 book');
  assert.equal(groups[3].label, 'Earlier');
});

test('shelf: the undated group keeps its input order and is absent when there are none', () => {
  const groups = shelfGroups([{ id: 1, finishedAt: at(2026, 5, 1) }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].year, 2026);
  assert.deepEqual(shelfGroups([{ id: 9 }, { id: 8 }]).map((g) => g.books.map((b) => b.id)), [[9, 8]]);
});
