import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFullCast, narratorCount, cleanFullCastTitle, selectSourceResults } from '../src/scrapers/cast';

test('cast: titles that mark themselves as full cast or dramatised', () => {
  assert.ok(isFullCast({ title: 'Dune (Full Cast)' }));
  assert.ok(isFullCast({ title: 'The Sandman [Dramatized Adaptation]' }));
  assert.ok(isFullCast({ title: 'GraphicAudio - Mistborn' }));
  assert.ok(isFullCast({ title: 'The Hobbit: A Movie in Your Mind' }));
  assert.ok(isFullCast({ title: 'Doctor Who: The Audio Drama' }));
  assert.ok(isFullCast({ title: 'A BBC radio full-cast dramatisation' }));
});

test('cast: a plain title is not full cast', () => {
  assert.ok(!isFullCast({ title: 'The Broadcast' }));
  assert.ok(!isFullCast({ title: 'Forecast' }));
  assert.ok(!isFullCast({ title: 'Dune' }));
  assert.ok(!isFullCast({ title: 'The Cast' }));
});

test('cast: four or more narrators make it a full cast, two do not', () => {
  assert.ok(isFullCast({ title: 'Dune', narrator: 'Scott Brick, Orlagh Cassidy, Euan Morton, Simon Vance' }));
  assert.ok(!isFullCast({ title: 'Dune', narrator: 'George Guidall' }));
  assert.ok(!isFullCast({ title: 'Dune', narrator: 'George Guidall, Scott Brick' }));
});

test('cast: the narrator field itself can say it', () => {
  assert.ok(isFullCast({ title: 'Dune', narrator: 'full cast' }));
  assert.ok(isFullCast({ title: 'Dune', narrator: 'A Full Cast' }));
  assert.ok(isFullCast({ title: 'Dune', narrator: 'various' }));
  assert.ok(!isFullCast({ title: 'Dune', narrator: 'Scott Brick' }));
});

test('cast: counting narrators across the usual separators', () => {
  assert.equal(narratorCount(undefined), 0);
  assert.equal(narratorCount(''), 0);
  assert.equal(narratorCount('George Guidall'), 1);
  assert.equal(narratorCount('Scott Brick, Orlagh Cassidy, Euan Morton, Simon Vance'), 4);
  assert.equal(narratorCount('A & B and C; D / E'), 5);
});

test('cast: cleaning a catalogue title of production notes', () => {
  assert.equal(cleanFullCastTitle('Dune (1 of 2) [Dramatized Adaptation]'), 'Dune');
  assert.equal(cleanFullCastTitle('Mistborn (Full-Cast Edition)'), 'Mistborn');
  assert.equal(cleanFullCastTitle('The Sandman (Dramatized)'), 'The Sandman');
  assert.equal(cleanFullCastTitle('Dune: Full cast dramatisation'), 'Dune');
  assert.equal(cleanFullCastTitle('Dune - A dramatized adaptation'), 'Dune');
  assert.equal(cleanFullCastTitle('The Hobbit [Dramatized Adaptation]'), 'The Hobbit');
  assert.equal(cleanFullCastTitle('Rain of Shadows and Endings (2 of 2) [Dramatized Adaptation] : The Legacy 1 (The Legacy)'), 'Rain of Shadows and Endings');
  assert.equal(cleanFullCastTitle('Red Rising (1 of 2) [Dramatized Adaptation]: Red Rising 1'), 'Red Rising');
  // A real parenthetical, or a subtitle that isn't a production note, is kept.
  assert.equal(cleanFullCastTitle('Leviathan Wakes (The Expanse 1)'), 'Leviathan Wakes (The Expanse 1)');
  assert.equal(cleanFullCastTitle('Dune Messiah: Book 2 of the Dune Chronicles'), 'Dune Messiah: Book 2 of the Dune Chronicles');
  assert.equal(cleanFullCastTitle('Dune'), 'Dune');
  assert.equal(cleanFullCastTitle(''), '');
});

test('cast: selecting results by source and the full-cast toggle', () => {
  const r = (id: string, scraperId: string, title: string) => ({ id, scraperId, title });
  const results = [
    r('1', 'a', 'Dune (Full Cast)'),
    r('2', 'b', 'Dune'),
    r('3', 'a', 'Mistborn'),
    r('4', 'b', 'The Sandman [Dramatized Adaptation]'),
  ];
  assert.deepEqual(selectSourceResults(results, null, false).map((x) => x.id), ['1', '2', '3', '4']);
  assert.deepEqual(selectSourceResults(results, 'a', false).map((x) => x.id), ['1', '3']);
  assert.deepEqual(selectSourceResults(results, null, true).map((x) => x.id), ['1', '4']);
  assert.deepEqual(selectSourceResults(results, 'b', true).map((x) => x.id), ['4']);
  assert.deepEqual(selectSourceResults([], null, true), []);
});
