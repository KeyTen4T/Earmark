import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardRows, finishedRows, bookMetrics } from '../src/library-rows';
import type { TBTorrent } from '../src/torbox';

const book = (id: number, name: string, files: { id: number; name: string; size: number }[] = []): TBTorrent => ({
  id,
  name,
  hash: `h${id}`,
  size: files.reduce((n, f) => n + f.size, 0),
  download_finished: true,
  download_present: true,
  progress: 1,
  download_state: 'cached',
  files: files.map((f) => ({ ...f, mimetype: 'audio/mpeg' })),
});

test('library-rows: cardRows groups books into rows of cols and clamps cols', () => {
  const books = [1, 2, 3, 4, 5].map((n) => book(n, `Book ${n}`));
  const rows = cardRows(books, 2);
  assert.deepEqual(rows.map((r) => r.kind), ['cards', 'cards', 'cards']);
  assert.deepEqual(rows.map((r) => (r.kind === 'cards' ? r.books.map((b) => b.id) : [])), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(rows.map((r) => r.key), ['cards-1', 'cards-3', 'cards-5']);
  // a zero or negative column count still yields one book per row
  assert.equal(cardRows(books, 0).length, 5);
  assert.equal(cardRows(books, -3).length, 5);
  assert.deepEqual(cardRows([], 4), []);
});

test('library-rows: finishedRows puts a heading before each year group', () => {
  const groups = [
    { year: 2026, label: '2026 · 2 books', books: [{ key: 'b1' }, { key: 'b2' }] },
    { year: null, label: 'Earlier', books: [{ key: 'e1' }] },
  ];
  const rows = finishedRows(groups, (g) => g.key);
  assert.deepEqual(rows.map((r) => r.kind), ['heading', 'item', 'item', 'heading', 'item']);
  assert.equal(rows[0].kind === 'heading' && rows[0].label, '2026 · 2 books');
  const items = rows.filter((r) => r.kind === 'item') as Extract<(typeof rows)[number], { kind: 'item' }>[];
  assert.deepEqual(items.map((r) => r.key), ['b1', 'b2', 'e1']);
  assert.deepEqual(items.map((r) => r.index), [0, 1, 0]);
  assert.equal(rows[3].key, 'year-earlier');
});

test('library-rows: bookMetrics computes fraction, remaining time and the spoken label', () => {
  const b = book(7, 'Dune', [
    { id: 1, name: '01.mp3', size: 100 },
    { id: 2, name: '02.mp3', size: 600 },
    { id: 3, name: '03.mp3', size: 300 },
  ]);
  const progress = { chapterIndex: 1, position: 300, duration: 600, chapterCount: 3 };
  const m = bookMetrics({ book: b, progress, meta: { author: 'Frank Herbert' } });
  assert.equal(m.chapterCount, 3);
  assert.deepEqual(m.sizes, [100, 600, 300]);
  assert.equal(m.fraction, 0.4);
  assert.equal(m.leftSeconds, 600);
  assert.equal(m.finished, false);
  assert.equal(m.hasProgress, true);
  assert.equal(m.title, 'Dune');
  assert.equal(m.label, 'Dune, Frank Herbert, 40% listened');

  const done = bookMetrics({ book: b, progress: { ...progress, finished: true }, meta: {} });
  assert.equal(done.finished, true);
  assert.equal(done.fraction, 1);
  assert.equal(done.leftSeconds, null);
  assert.equal(done.label, 'Dune, finished');

  const playing = bookMetrics({ book: b, meta: {}, nowPlayingId: 7 });
  assert.equal(playing.playing, true);
  assert.equal(playing.hasProgress, false);
  assert.equal(playing.fraction, 0);
  assert.equal(playing.leftSeconds, null);
  assert.equal(playing.label, 'Dune, now playing');
});
