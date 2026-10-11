import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playerPanes } from '../src/player/panes';

test('panes: phone layout never splits', () => {
  assert.deepEqual(playerPanes({ wide: false, chapterCount: 12, hasReadalong: true, showText: true }),
    { twoPane: false, right: null, textFixed: false });
});

test('panes: a wide book shows chapters, and the text when Read is on', () => {
  assert.deepEqual(playerPanes({ wide: true, chapterCount: 12, hasReadalong: true, showText: false }),
    { twoPane: true, right: 'chapters', textFixed: false });
  assert.deepEqual(playerPanes({ wide: true, chapterCount: 12, hasReadalong: true, showText: true }),
    { twoPane: true, right: 'text', textFixed: false });
  // No read-along built yet: the pane stays on the chapter list either way.
  assert.deepEqual(playerPanes({ wide: true, chapterCount: 12, hasReadalong: false, showText: false }),
    { twoPane: true, right: 'chapters', textFixed: false });
});

test('panes: a one-file book with a read-along pins the text in the pane', () => {
  assert.deepEqual(playerPanes({ wide: true, chapterCount: 1, hasReadalong: true, showText: false }),
    { twoPane: true, right: 'text', textFixed: true });
  assert.deepEqual(playerPanes({ wide: true, chapterCount: 1, hasReadalong: true, showText: true }),
    { twoPane: true, right: 'text', textFixed: true });
});

test('panes: a one-file book with no read-along has no second pane', () => {
  assert.deepEqual(playerPanes({ wide: true, chapterCount: 1, hasReadalong: false, showText: false }),
    { twoPane: false, right: null, textFixed: false });
  // An empty file list counts as one file for this decision.
  assert.deepEqual(playerPanes({ wide: true, chapterCount: 0, hasReadalong: false, showText: false }),
    { twoPane: false, right: null, textFixed: false });
});
