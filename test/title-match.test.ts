import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchTitle } from '../src/title-match';

test('title-match: accepts a title and author that both appear in the name', () => {
  assert.deepEqual(
    matchTitle('Andy Weir - Project Hail Mary [Unabridged] [MP3 64kbps]', [{ title: 'Project Hail Mary', author: 'Andy Weir' }]),
    { title: 'Project Hail Mary', author: 'Andy Weir' },
  );
  assert.deepEqual(
    matchTitle('Dune.Frank.Herbert.Audiobook.mp3', [{ title: 'Dune', author: 'Frank Herbert' }]),
    { title: 'Dune', author: 'Frank Herbert' },
  );
  assert.deepEqual(
    matchTitle('The Hobbit - J R R Tolkien', [{ title: 'The Hobbit', author: 'J.R.R. Tolkien' }]),
    { title: 'The Hobbit', author: 'J.R.R. Tolkien' },
  );
});

test('title-match: rejects a different book by the same author', () => {
  assert.equal(matchTitle('Dune Frank Herbert Audiobook', [{ title: 'Dune Messiah', author: 'Frank Herbert' }]), undefined);
});

test('title-match: rejects a candidate by a different author', () => {
  assert.equal(matchTitle('Dune - Frank Herbert', [{ title: 'Dune', author: 'Kevin J. Anderson' }]), undefined);
});

test('title-match: prefers the longest accepted title and needs no author for a clear name', () => {
  assert.deepEqual(
    matchTitle('The Hobbit - J R R Tolkien', [{ title: 'The Hobbit', author: 'J.R.R. Tolkien' }, { title: 'Hobbit', author: 'J.R.R. Tolkien' }]),
    { title: 'The Hobbit', author: 'J.R.R. Tolkien' },
  );
  assert.deepEqual(matchTitle('The.Hobbit.1937.Audiobook.MP3', [{ title: 'The Hobbit' }]), { title: 'The Hobbit' });
});

test('title-match: returns undefined when nothing passes', () => {
  assert.equal(matchTitle('Some Unknown Recording', [{ title: 'An Entirely Different Book', author: 'Nobody Here' }]), undefined);
});
