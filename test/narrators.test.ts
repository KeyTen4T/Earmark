import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitNarrators, normalizeNarrator, isFavourite, resultFavourites, toggleNarrator,
  unionNarrators, favouriteFirst,
} from '../src/narrators';

test('narrators: split on the usual separators, dropping blanks', () => {
  assert.deepEqual(splitNarrators('George Guidall'), ['George Guidall']);
  assert.deepEqual(splitNarrators('Scott Brick, Orlagh Cassidy, Euan Morton, Simon Vance'),
    ['Scott Brick', 'Orlagh Cassidy', 'Euan Morton', 'Simon Vance']);
  assert.deepEqual(splitNarrators('A & B and C; D / E'), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(splitNarrators(undefined), []);
  assert.deepEqual(splitNarrators('  '), []);
  assert.deepEqual(splitNarrators('A, , B'), ['A', 'B']);
});

test('narrators: normalising ignores case, spacing, punctuation and a trailing marker', () => {
  assert.equal(normalizeNarrator('  J.  Smith '), 'j smith');
  assert.equal(normalizeNarrator('J Smith'), 'j smith');
  assert.equal(normalizeNarrator('J. Smith (narrator)'), 'j smith');
  assert.equal(normalizeNarrator('Scott Brick (Narrator)'), normalizeNarrator('scott brick'));
  // A marker in the middle is part of the name, only a trailing one is dropped.
  assert.equal(normalizeNarrator('(narrator) Scott Brick'), 'narrator scott brick');
  assert.equal(normalizeNarrator(''), '');
});

test('narrators: isFavourite compares through the normaliser', () => {
  const list = ['J. Smith', 'Scott Brick'];
  assert.ok(isFavourite('J Smith', list));
  assert.ok(isFavourite('j. smith (narrator)', list));
  assert.ok(isFavourite('scott   brick', list));
  assert.ok(!isFavourite('Orlagh Cassidy', list));
  assert.ok(!isFavourite('', list));
});

test('narrators: resultFavourites returns the followed names present, in followed order', () => {
  const list = ['J. Smith', 'Scott Brick', 'Orlagh Cassidy'];
  assert.deepEqual(resultFavourites('Scott Brick, Orlagh Cassidy', list), ['Scott Brick', 'Orlagh Cassidy']);
  // Typed differently in the result: the followed spelling is returned.
  assert.deepEqual(resultFavourites('J Smith and Euan Morton', list), ['J. Smith']);
  assert.deepEqual(resultFavourites('Nobody Here', list), []);
  assert.deepEqual(resultFavourites(undefined, list), []);
});

test('narrators: toggle adds as typed, removes a normalised match, ignores blanks', () => {
  assert.deepEqual(toggleNarrator('Scott Brick', []), ['Scott Brick']);
  assert.deepEqual(toggleNarrator('  Scott Brick  ', []), ['Scott Brick']);
  assert.deepEqual(toggleNarrator('J Smith', ['J. Smith']), []);
  assert.deepEqual(toggleNarrator('Scott Brick', ['J. Smith', 'Scott Brick']), ['J. Smith']);
  assert.deepEqual(toggleNarrator('', ['J. Smith']), ['J. Smith']);
  assert.deepEqual(toggleNarrator('   ', ['J. Smith']), ['J. Smith']);
});

test('narrators: union keeps first-seen spelling and drops normalised repeats', () => {
  assert.deepEqual(unionNarrators(['J. Smith', 'Scott Brick'], ['J Smith', 'Orlagh Cassidy']),
    ['J. Smith', 'Scott Brick', 'Orlagh Cassidy']);
  assert.deepEqual(unionNarrators([], ['A', '', '  ']), ['A']);
});

test('narrators: favouriteFirst moves followed results up, otherwise preserving order', () => {
  const rows = [
    { title: 'a', narrator: 'Nobody' },
    { title: 'b', narrator: 'Scott Brick' },
    { title: 'c' },
    { title: 'd', narrator: 'Orlagh Cassidy, Scott Brick' },
    { title: 'e', narrator: 'Nobody Else' },
  ];
  const out = favouriteFirst(rows, (r) => r.narrator, ['Scott Brick']);
  assert.deepEqual(out.map((r) => r.title), ['b', 'd', 'a', 'c', 'e']);
  // No favourites: exactly the original order.
  assert.deepEqual(favouriteFirst(rows, (r) => r.narrator, []).map((r) => r.title), ['a', 'b', 'c', 'd', 'e']);
});
