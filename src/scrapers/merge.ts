// One-time migration: sources that used to be fetched from a hosted built-in manifest are folded
// into the user's own sources. Pure (no react-native/expo imports) so the Node tests can run it.

import type { ScraperDef } from './engine';

/**
 * Appends each saved definition that has no user source with the same id, keeping the user's own
 * entries in place. Idempotent: running it again on its own result changes nothing.
 */
export function mergeRemoteBuiltins(saved: ScraperDef[], user: ScraperDef[]): ScraperDef[] {
  const ids = new Set(user.map((s) => s.id));
  const out = [...user];
  for (const def of saved) {
    if (!def?.id || ids.has(def.id)) continue;
    ids.add(def.id);
    out.push(def);
  }
  return out;
}
