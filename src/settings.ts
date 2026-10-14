// Pure playback settings: their defaults, the device-local vs synced split, and the merge of a
// stored (possibly older) object into the current shape. `storage.ts` wires these to AsyncStorage;
// keeping them here, with no react-native/expo imports, lets the Node test runner cover them.
//
// rate/skipBack/skipForward sync through the gist. seekStep, lastBookId and surround are
// device-local: the TV's own remote step and the TV's own audio route differ per device, so a
// change to them is never pushed as a synced edit.

export type SurroundSetting = 'auto' | 'stereo';

export type Settings = {
  rate: number;
  skipBack: number;
  skipForward: number;
  seekStep: number;
  surround: SurroundSetting;
  lastBookId?: number;
};

export const DEFAULT_SETTINGS: Settings = { rate: 1, skipBack: 15, skipForward: 30, seekStep: 5, surround: 'auto' };

/**
 * Fills a stored settings object out to the current shape. An object saved before `surround`
 * existed has no value there, so it becomes the default `'auto'`; any unrecognised value is
 * treated the same way rather than trusted.
 */
export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  if (merged.surround !== 'auto' && merged.surround !== 'stereo') merged.surround = 'auto';
  return merged;
}

/**
 * Whether two settings differ in a field that syncs. The device-local fields (seekStep, lastBookId
 * and surround) are deliberately excluded, so changing one is not a real change to push.
 */
export function syncedSettingsChanged(a: Settings, b: Settings): boolean {
  return a.rate !== b.rate || a.skipBack !== b.skipBack || a.skipForward !== b.skipForward;
}
