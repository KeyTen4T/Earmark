import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseGoodreadsExport, parseReadDate, NOT_GOODREADS } from '../src/goodreads';

const at = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

test('goodreads: csv handles quoted commas, newlines, doubled quotes, CRLF, a BOM and ="…" cells', () => {
  const csv = '\uFEFFBook Id,Title,ISBN\r\n1,"Dune, Book One",="0123456789"\r\n2,"Line\nBreak",x\r\n3,"A ""quoted"" name",y\r\n';
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['Book Id', 'Title', 'ISBN']);
  assert.equal(rows[1][1], 'Dune, Book One');
  assert.equal(rows[1][2], '0123456789');
  assert.equal(rows[2][1], 'Line\nBreak');
  assert.equal(rows[3][1], 'A "quoted" name');
  assert.equal(rows.length, 4);
  // A quote inside an unquoted field is literal, not the start of one.
  assert.deepEqual(parseCsv('a,b"c')[0], ['a', 'b"c']);
});

test('goodreads: maps read rows, drops other shelves and unrated/undated blanks', () => {
  const csv = [
    'Book Id,Title,Author,Exclusive Shelf,My Rating,Date Read,ISBN',
    '1,The Quiet Machine,Ada Vance,read,4,2024/03/02,="0123456789"',
    '2,Unfinished Thing,Someone,currently-reading,0,,="0987654321"',
    '3,Another Read,Bo Stone,read,0,2023/12/31,',
    '4,No Date Read,Cy Marsh,read,5,,',
  ].join('\n');
  const got = parseGoodreadsExport(csv);
  assert.deepEqual(got.map((e) => [e.id, e.title, e.rating, e.finishedAt]), [
    ['gr:1', 'The Quiet Machine', 4, at(2024, 2, 2)],
    ['gr:3', 'Another Read', undefined, at(2023, 11, 31)],
    ['gr:4', 'No Date Read', 5, undefined],
  ]);
  assert.equal(got[0].source, 'goodreads');
  assert.equal(got[0].author, 'Ada Vance');
  assert.equal(got[1].author, 'Bo Stone');
});

test('goodreads: an unknown or missing column is a readable error, not a guess', () => {
  assert.throws(() => parseGoodreadsExport('a,b,c\n1,2,3'), /Goodreads export/);
  assert.throws(() => parseGoodreadsExport('Book Id,Title\n1,Dune'), /Goodreads export/);
  assert.throws(() => parseGoodreadsExport(''), /Goodreads export/);
  assert.match(NOT_GOODREADS, /Goodreads export/);
});

test('goodreads: a read date is a local day and anything else is empty', () => {
  assert.equal(parseReadDate('2024/03/02'), at(2024, 2, 2));
  assert.equal(parseReadDate('2024/3/2'), at(2024, 2, 2));
  assert.equal(parseReadDate(''), undefined);
  assert.equal(parseReadDate('March 2024'), undefined);
});
