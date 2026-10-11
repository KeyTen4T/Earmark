import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRemoteBuiltins } from '../src/scrapers/merge';
import type { ScraperDef } from '../src/scrapers/engine';

const def = (id: string): ScraperDef => ({
  id, name: id, type: 'json',
  search: { url: 'https://example.com/search?q={query}' },
  results: { fields: { title: '{t}', infoHash: '{h}' } },
});

test('mergeRemoteBuiltins leaves the user sources untouched when nothing was saved', () => {
  const user = [def('mine')];
  assert.deepEqual(mergeRemoteBuiltins([], user), user);
});

test('mergeRemoteBuiltins adds a saved definition to the user sources', () => {
  const out = mergeRemoteBuiltins([def('forge-fable')], [def('mine')]);
  assert.deepEqual(out.map((s) => s.id), ['mine', 'forge-fable']);
});

test('mergeRemoteBuiltins does not duplicate an id that is already a user source', () => {
  const out = mergeRemoteBuiltins([def('forge-fable')], [def('forge-fable')]);
  assert.equal(out.filter((s) => s.id === 'forge-fable').length, 1);
});

test('mergeRemoteBuiltins is idempotent on a second run', () => {
  const saved = [def('a'), def('b')];
  const once = mergeRemoteBuiltins(saved, [def('mine')]);
  const twice = mergeRemoteBuiltins(saved, once);
  assert.deepEqual(twice.map((s) => s.id), once.map((s) => s.id));
  assert.deepEqual(twice, once);
});
