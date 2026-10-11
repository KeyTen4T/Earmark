import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFullCast, narratorCount } from '../src/scrapers/cast';

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
