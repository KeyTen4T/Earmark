// Tiny event bus for sync, with no React Native or Expo imports so anything can subscribe.
// Two kinds of event:
//   localChange  - a synced record changed locally; the coordinator debounces a sync.
//   syncApplied  - a sync cycle finished and may have changed what's stored; screens reload.

type Listener = () => void;

const localChangeListeners = new Set<Listener>();
const syncAppliedListeners = new Set<Listener>();

/** Fired by the storage setters whenever a synced value actually changes locally. */
export function emitLocalChange(): void {
  for (const l of localChangeListeners) l();
}

export function onLocalChange(fn: Listener): () => void {
  localChangeListeners.add(fn);
  return () => { localChangeListeners.delete(fn); };
}

/** Fired after a sync cycle has merged and written any newer remote data. */
export function emitSyncApplied(): void {
  for (const l of syncAppliedListeners) l();
}

export function onSyncApplied(fn: Listener): () => void {
  syncAppliedListeners.add(fn);
  return () => { syncAppliedListeners.delete(fn); };
}
