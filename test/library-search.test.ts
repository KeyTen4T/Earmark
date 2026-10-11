import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesLibrarySearch, libraryHaystack } from '../src/library-search';

test('library-search: an empty query matches everything', () => {
  assert.equal(matchesLibrarySearch('Dune', { title: 'Dune' }, ''), true);
  assert.equal(matchesLibrarySearch('Dune', undefined, '   '), true);
});

test('library-search: matches title, author and narrator case-insensitively', () => {
  const meta = { title: 'Project Hail Mary', author: 'Andy Weir', narrator: 'Ray Porter' };
  assert.equal(matchesLibrarySearch('some-file', meta, 'hail'), true);
  assert.equal(matchesLibrarySearch('some-file', meta, 'ANDY'), true);
  assert.equal(matchesLibrarySearch('some-file', meta, 'ray porter'), true);
  assert.equal(matchesLibrarySearch('some-file', meta, 'dune'), false);
});

test('library-search: every typed word must match', () => {
  const meta = { title: 'The Hobbit', author: 'J R R Tolkien' };
  assert.equal(matchesLibrarySearch('x', meta, 'hobbit tolkien'), true);
  assert.equal(matchesLibrarySearch('x', meta, 'hobbit dune'), false);
});

test('library-search: falls back to the cleaned torrent name when meta is missing', () => {
  assert.equal(matchesLibrarySearch('Dune.Frank.Herbert.Audiobook.mp3', undefined, 'frank herbert'), true);
  assert.equal(matchesLibrarySearch('Dune.Frank.Herbert.Audiobook.mp3', {}, 'dune'), true);
  assert.equal(matchesLibrarySearch('The.Hobbit.1937.MP3', { title: 'The Hobbit' }, 'hobbit'), true);
});

test('library-search: the haystack joins the known fields', () => {
  assert.equal(libraryHaystack('x', { title: 'A', author: 'B', narrator: 'C' }), 'a b c x');
});
