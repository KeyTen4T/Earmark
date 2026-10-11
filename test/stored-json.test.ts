import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStored } from '../src/json-store';

test('stored JSON: a present but unreadable value is corruption, a missing one is not', () => {
  assert.deepEqual(parseStored('{"a":1}', {}), { value: { a: 1 }, corrupt: false });
  assert.deepEqual(parseStored('null', 7), { value: null, corrupt: false });
  // Missing is not corruption and must behave exactly as before.
  assert.deepEqual(parseStored(null, { a: 1 }), { value: { a: 1 }, corrupt: false });
  assert.deepEqual(parseStored('', { a: 1 }), { value: { a: 1 }, corrupt: false });
  // A stored value that fails to parse is reported so the caller can keep a copy.
  const bad = parseStored('{not json', { a: 1 });
  assert.equal(bad.corrupt, true);
  assert.deepEqual(bad.value, { a: 1 });
});
