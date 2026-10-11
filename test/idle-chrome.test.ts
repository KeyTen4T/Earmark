import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seekAllowed, CHROME_SEEK_GUARD_MS } from '../src/player/idle-chrome';

// The tap that reveals the hidden chrome must not also seek, and neither must one just after it.
test('seekAllowed blocks the revealing tap and any tap within the guard', () => {
  const t = 10_000;
  assert.equal(seekAllowed(true, 0, t), false); // chrome was hidden when the touch began
  assert.equal(seekAllowed(false, t, t), false); // revealed this instant
  assert.equal(seekAllowed(false, t, t + CHROME_SEEK_GUARD_MS - 1), false);
  assert.equal(seekAllowed(false, t, t + CHROME_SEEK_GUARD_MS), true);
  assert.equal(seekAllowed(false, 0, t), true); // long after any reveal
});
