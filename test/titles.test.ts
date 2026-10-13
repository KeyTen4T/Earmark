import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prettyName, audioTags } from '../src/titles';

test('prettyName: the examples from the task', () => {
  assert.equal(prettyName('Harry Potter - Opus 5.1ch Encode'), 'Harry Potter');
  assert.equal(prettyName('Dune - Frank Herbert (Unabridged) [MP3 64kbps]'), 'Dune - Frank Herbert');
  assert.equal(prettyName('Mistborn [01] The Final Empire'), 'Mistborn [01] The Final Empire');
  assert.equal(prettyName('Andy.Weir.-.Project.Hail.Mary.2021.m4b'), 'Andy Weir - Project Hail Mary 2021');
});

test('prettyName: it does not damage real titles', () => {
  assert.equal(prettyName('Dune'), 'Dune');
  assert.equal(prettyName('1984'), '1984');
  assert.equal(prettyName('Catch-22'), 'Catch-22');
  assert.equal(prettyName('The 5 Love Languages'), 'The 5 Love Languages');
  assert.equal(prettyName('Stereo Hearts'), 'Stereo Hearts');
  assert.equal(prettyName('The Book - A Story'), 'The Book - A Story');
});

test('prettyName: keeps what the old logic did (extensions, dots, brackets, spaces)', () => {
  assert.equal(prettyName('Book.m4b'), 'Book');
  assert.equal(prettyName('Book.MP3'), 'Book');
  assert.equal(prettyName('Some Title.zip'), 'Some Title');
  assert.equal(prettyName('A.B_C'), 'A B C');
  assert.equal(prettyName('Book [MP3]'), 'Book');
  assert.equal(prettyName('Book (Unabridged)'), 'Book');
  assert.equal(prettyName('Book (64kbps)'), 'Book');
  assert.equal(prettyName('Book   With    Spaces'), 'Book With Spaces');
});

test('prettyName: decimal channel layouts survive the dots-to-spaces step', () => {
  assert.equal(prettyName('Book 5.1ch'), 'Book');
  assert.equal(prettyName('Book 7.1'), 'Book');
  assert.equal(prettyName('Book 2.0'), 'Book');
  // A dot between digits that is not a channel layout is left alone.
  assert.equal(prettyName('Book 5.5'), 'Book 5.5');
  assert.equal(prettyName('Book v1.2'), 'Book v1.2');
});

test('prettyName: strips codecs, channel words, bitrates and the always-tag words', () => {
  assert.equal(prettyName('Dune Opus'), 'Dune');
  assert.equal(prettyName('Dune FLAC'), 'Dune');
  assert.equal(prettyName('Dune HE-AAC'), 'Dune');
  assert.equal(prettyName('Dune eac3'), 'Dune');
  assert.equal(prettyName('Dune Atmos'), 'Dune');
  assert.equal(prettyName('Dune 128 kbps'), 'Dune');
  assert.equal(prettyName('Dune 64kbps'), 'Dune');
  assert.equal(prettyName('Dune 64k'), 'Dune');
  assert.equal(prettyName('Dune Unabridged'), 'Dune');
  assert.equal(prettyName('Dune audio book'), 'Dune');
  assert.equal(prettyName('Dune [Opus 5.1ch 320kbps]'), 'Dune');
});

test('prettyName: bare stereo/mono/surround/retail/rip/encode only after " - " or at the end', () => {
  assert.equal(prettyName('Dune - Encode'), 'Dune');
  assert.equal(prettyName('Dune Encode'), 'Dune');
  assert.equal(prettyName('Dune - Stereo'), 'Dune');
  assert.equal(prettyName('Dune Stereo'), 'Dune');
  assert.equal(prettyName('Dune - Retail'), 'Dune');
  assert.equal(prettyName('Dune Rip'), 'Dune');
  assert.equal(prettyName('Dune - Mono'), 'Dune');
  // Mid-sentence they are kept: these read like titles, not formats.
  assert.equal(prettyName('Encode My Heart'), 'Encode My Heart');
  assert.equal(prettyName('Rip Van Winkle'), 'Rip Van Winkle');
  assert.equal(prettyName('The Stereo Hearts'), 'The Stereo Hearts');
});

test('prettyName: removes dangling separators left behind', () => {
  assert.equal(prettyName('Dune - Opus'), 'Dune');
  assert.equal(prettyName('Dune - - Opus'), 'Dune');
  assert.equal(prettyName('Dune - Opus -'), 'Dune');
  assert.equal(prettyName('Dune - Opus - -'), 'Dune');
  assert.equal(prettyName('Dune - Opus - Frank Herbert'), 'Dune - Frank Herbert');
  assert.equal(prettyName('Dune ()'), 'Dune');
  assert.equal(prettyName('[MP3] Dune'), 'Dune');
  assert.equal(prettyName('Dune [MP3 64kbps]'), 'Dune');
});

test('prettyName: never returns an empty string', () => {
  // Everything stripped -> the old result is used.
  assert.equal(prettyName('Opus'), 'Opus');
  assert.equal(prettyName('5.1ch'), '5 1ch');
  assert.notEqual(prettyName('[MP3]'), '');
  assert.notEqual(prettyName('[MP3] 64kbps'), '');
});

test('audioTags: channel first, then codec', () => {
  assert.deepEqual(audioTags('Harry Potter - Opus 5.1ch Encode'), ['5.1', 'Opus']);
  assert.deepEqual(audioTags('Dune - Frank Herbert (Unabridged) [MP3 64kbps]'), ['MP3']);
  assert.deepEqual(audioTags('Book 7.1 FLAC'), ['7.1', 'FLAC']);
  assert.deepEqual(audioTags('Book Atmos Opus'), ['Atmos', 'Opus']);
  assert.deepEqual(audioTags('Book 5.1 Atmos Opus'), ['5.1', 'Atmos', 'Opus']);
  assert.deepEqual(audioTags('Book AAC'), ['AAC']);
  assert.deepEqual(audioTags('Book 128kbps MP3'), ['MP3']);
  assert.deepEqual(audioTags('Dune.m4b'), ['M4B']);
});

test('audioTags: no badge for stereo, mono or 2.0, and no duplicates', () => {
  assert.deepEqual(audioTags('Book 2.0 Stereo Mono'), []);
  assert.deepEqual(audioTags('Dune'), []);
  assert.deepEqual(audioTags('Mistborn [01] The Final Empire'), []);
  assert.deepEqual(audioTags('Opus Opus Opus'), ['Opus']);
});
