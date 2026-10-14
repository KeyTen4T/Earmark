import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, mergeSettings, syncedSettingsChanged } from '../src/settings';

// The playback settings merge is pure: an old saved object predates `surround`, so it must come
// back as 'auto'; and the device-local fields must never read as a synced change.

test('settings: an old saved object gains surround: auto', () => {
  const s = mergeSettings({ rate: 1.5, skipBack: 10, skipForward: 30, seekStep: 15 });
  assert.equal(s.surround, 'auto');
  assert.equal(s.rate, 1.5);
  assert.equal(s.skipBack, 10);
  assert.equal(s.seekStep, 15);
});

test('settings: a missing or empty stored object uses all defaults', () => {
  assert.deepEqual(mergeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings({}), DEFAULT_SETTINGS);
});

test('settings: an unknown stored surround value falls back to auto', () => {
  assert.equal(mergeSettings({ surround: 'surround' as any }).surround, 'auto');
  assert.equal(mergeSettings({ surround: 'stereo' }).surround, 'stereo');
});

test('settings: rewindAfterPause defaults on and rejects non-booleans', () => {
  assert.equal(DEFAULT_SETTINGS.rewindAfterPause, true);
  assert.equal(mergeSettings({}).rewindAfterPause, true);
  assert.equal(mergeSettings({ rewindAfterPause: undefined }).rewindAfterPause, true);
  assert.equal(mergeSettings({ rewindAfterPause: 'yes' as any }).rewindAfterPause, true);
  assert.equal(mergeSettings({ rewindAfterPause: 0 as any }).rewindAfterPause, true);
  assert.equal(mergeSettings({ rewindAfterPause: false }).rewindAfterPause, false);
  assert.equal(mergeSettings({ rewindAfterPause: true }).rewindAfterPause, true);
});

test('settings: only the synced fields count as a real change', () => {
  const base = mergeSettings({ rate: 1.25, skipBack: 10, skipForward: 30, seekStep: 5, surround: 'auto' });
  assert.equal(syncedSettingsChanged(base, { ...base, surround: 'stereo' }), false);
  assert.equal(syncedSettingsChanged(base, { ...base, seekStep: 60 }), false);
  assert.equal(syncedSettingsChanged(base, { ...base, rewindAfterPause: false }), false);
  assert.equal(syncedSettingsChanged(base, { ...base, lastBookId: 7 }), false);
  assert.equal(syncedSettingsChanged(base, { ...base, rate: 1.5 }), true);
  assert.equal(syncedSettingsChanged(base, { ...base, skipBack: 30 }), true);
  assert.equal(syncedSettingsChanged(base, { ...base, skipForward: 60 }), true);
});
