import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapHardcoverHistory, parseFinishedDate, planReadingImport, sameLibraryBook,
  type ReadElsewhere,
} from '../src/reading-history';

const entry = (id: string, title: string, over: Partial<ReadElsewhere> = {}): ReadElsewhere =>
  ({ id, source: 'goodreads', title, ...over });
const book = (hash: string, title: string, over: Partial<{ author: string; finished: boolean; rating: number; finishedAt: number }> = {}) =>
  ({ hash, title, finished: true, ...over });

test('reading history: the strict matcher needs the same cleaned title and a shared author', () => {
  assert.ok(sameLibraryBook({ title: 'The Hollow Sky' }, { title: 'The Hollow Sky (Unabridged)' }));
  assert.ok(sameLibraryBook({ title: 'The Hollow Sky', author: 'Ada Vance' }, { title: 'The Hollow Sky', author: 'Bo Vance' }));
  assert.ok(sameLibraryBook({ title: 'The Hollow Sky', author: 'Ada Vance' }, { title: 'The Hollow Sky: Book One' }));
  assert.equal(sameLibraryBook({ title: 'The Hollow Sky', author: 'Ada Vance' }, { title: 'The Hollow Sky', author: 'Cy Marsh' }), false);
  assert.equal(sameLibraryBook({ title: 'The Hollow Sky' }, { title: 'Glass Harbor' }), false);
  // One side naming no author leaves the title to decide.
  assert.ok(sameLibraryBook({ title: 'The Hollow Sky', author: 'Ada Vance' }, { title: 'The Hollow Sky' }));
  assert.equal(sameLibraryBook({ title: '' }, { title: 'The Hollow Sky' }), false);
});

test('reading history: plan fills finished books, skips unfinished ones and adds the rest', () => {
  const library = [book('h1', 'The Hollow Sky'), book('h2', 'Glass Harbor', { finished: false })];
  const found = [
    entry('gr:1', 'The Hollow Sky', { rating: 5, finishedAt: 100 }),
    entry('gr:2', 'Glass Harbor'),
    entry('gr:3', 'The Quiet Machine', { author: 'Ada Vance' }),
  ];
  const plan = planReadingImport(found, library, []);
  assert.equal(plan.found, 3);
  assert.equal(plan.matchedFinished, 1);
  assert.equal(plan.gainRating, 1);
  assert.equal(plan.gainDate, 1);
  assert.equal(plan.skippedUnfinished, 1);
  assert.equal(plan.added, 1);
  assert.equal(plan.updated, 0);
  assert.deepEqual(plan.fills, [{ hash: 'h1', rating: 5, finishedAt: 100 }]);
  assert.deepEqual(plan.entries.map((e) => e.id), ['gr:3']);
});

test('reading history: an existing rating or date is never overwritten', () => {
  const library = [book('h1', 'The Hollow Sky', { rating: 3, finishedAt: 50 })];
  const found = [entry('gr:1', 'The Hollow Sky', { rating: 5, finishedAt: 100 })];
  const plan = planReadingImport(found, library, []);
  assert.equal(plan.matchedFinished, 1);
  assert.equal(plan.gainRating, 0);
  assert.equal(plan.gainDate, 0);
  assert.deepEqual(plan.fills, []);
});

test('reading history: importing the same source twice does not duplicate entries', () => {
  const found = [entry('gr:1', 'The Quiet Machine'), entry('gr:2', 'Winter Almanac')];
  const first = planReadingImport(found, [], []);
  assert.equal(first.added, 2);
  assert.equal(first.updated, 0);
  const second = planReadingImport(found, [], first.entries);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 2);
  assert.deepEqual(second.entries.map((e) => e.id), ['gr:1', 'gr:2']);
});

test('reading history: a removed entry stays removed and is not re-added', () => {
  const found = [entry('gr:1', 'The Quiet Machine'), entry('gr:2', 'Winter Almanac')];
  const second = planReadingImport(found, [], [entry('gr:1', 'The Quiet Machine'), entry('gr:2', 'Winter Almanac')], ['gr:1']);
  assert.deepEqual(second.entries.map((e) => e.id), ['gr:2']);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
});

test('reading history: an entry that now matches a library book leaves the shelf', () => {
  const plan = planReadingImport([entry('gr:1', 'The Hollow Sky')], [book('h1', 'The Hollow Sky')], [entry('gr:1', 'The Hollow Sky')]);
  assert.equal(plan.matchedFinished, 1);
  assert.deepEqual(plan.entries, []);
});

test('reading history: Hardcover rows map to entries and incomplete rows are dropped', () => {
  const rows = [
    { id: 1, rating: 4.5, book: { id: 11, title: 'The Quiet Machine', image: { url: 'https://img/a.jpg' }, contributions: [{ author: { name: 'Ada Vance' } }, { author: { name: 'Bo Stone' } }] }, user_book_reads: [{ finished_at: '2024-01-02' }, { finished_at: '2024-05-06' }] },
    { id: 2, rating: 0, book: { id: 12, title: 'Unrated Yarn' }, user_book_reads: [{ finished_at: null }] },
    { id: 3, rating: 3, book: { id: null, title: 'No id' }, user_book_reads: [] },
    null,
  ];
  const got = mapHardcoverHistory(rows);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], {
    id: 'hc:11', source: 'hardcover', title: 'The Quiet Machine', author: 'Ada Vance, Bo Stone',
    cover: 'https://img/a.jpg', finishedAt: new Date(2024, 4, 6).getTime(), rating: 4.5,
  });
  assert.equal(got[1].id, 'hc:12');
  assert.equal(got[1].rating, undefined);
  assert.equal(got[1].finishedAt, undefined);
});

test('reading history: a Hardcover finish date parses as a local day', () => {
  assert.equal(parseFinishedDate('2024-05-06'), new Date(2024, 4, 6).getTime());
  assert.equal(parseFinishedDate(''), undefined);
  assert.equal(parseFinishedDate(undefined), undefined);
  assert.equal(parseFinishedDate('nonsense'), undefined);
  assert.deepEqual(mapHardcoverHistory('nope'), []);
});
