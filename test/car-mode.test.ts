import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carProgress, carRemaining, carChapterLine } from '../src/player/car-mode';

test('car progress is clamped and zero without a duration', () => {
  assert.equal(carProgress(0, 600), 0);
  assert.equal(carProgress(300, 600), 0.5);
  assert.equal(carProgress(900, 600), 1);
  assert.equal(carProgress(-5, 600), 0);
  assert.equal(carProgress(100, 0), 0);
  assert.equal(carProgress(100, NaN), 0);
});

test('car remaining time never goes negative', () => {
  assert.equal(carRemaining(120, 600), 480);
  assert.equal(carRemaining(700, 600), 0);
  assert.equal(carRemaining(0, 0), 0);
  assert.equal(carRemaining(NaN, 600), 600);
});

test('car chapter line adds the chapter name only when it is not the title', () => {
  assert.equal(carChapterLine(0, 12, 'The Beginning', 'Dune'), 'Chapter 1 of 12 · The Beginning');
  assert.equal(carChapterLine(2, 12, 'Dune', 'Dune'), 'Chapter 3 of 12');
  assert.equal(carChapterLine(2, 12, '  dune  ', 'Dune'), 'Chapter 3 of 12');
  assert.equal(carChapterLine(2, 12, '', 'Dune'), 'Chapter 3 of 12');
  assert.equal(carChapterLine(0, 1, 'Track One', ''), 'Chapter 1 of 1 · Track One');
});
