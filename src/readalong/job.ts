// The single read-along build job, shared at module level so its progress survives closing the
// sheet (or the player) and reopening it. create.ts drives it; the sheet subscribes.
//
// Pure: no react-native/expo imports (the React hook lives in ReadalongSheet.tsx), so it runs under
// the Node test runner too.

import type { ReadalongEvent } from './desktop';

export type ReadalongJobState =
  | { status: 'idle' }
  | { status: 'preparing'; message: string }
  | { status: 'downloading'; bytes: number; total: number }
  | { status: 'building'; done: number; total: number }
  | { status: 'done'; matched: number; total: number }
  | { status: 'error'; message: string }
  | { status: 'cancelled' };

let state: ReadalongJobState = { status: 'idle' };
const listeners = new Set<() => void>();

function set(next: ReadalongJobState) {
  state = next;
  for (const listener of listeners) listener();
}

/** The current job state (stable reference until it changes). */
export const getJob = (): ReadalongJobState => state;

/** Subscribe to job changes; returns an unsubscribe function. */
export function subscribeJob(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether a build is on the go (drives the active pill/button styling). */
export const jobActive = (s: ReadalongJobState): boolean =>
  s.status === 'preparing' || s.status === 'downloading' || s.status === 'building';

export const resetJob = () => set({ status: 'idle' });
export const preparing = (message: string) => set({ status: 'preparing', message });
export const cancelled = () => set({ status: 'cancelled' });
export const failed = (message: string) => set({ status: 'error', message });

/**
 * Merges one `readalong.py --progress-json` event. `start` opens the clip tally,
 * `download` reports audio bytes, `clip` advances the tally, `done`/`error` finish the job.
 */
export function applyJobEvent(event: ReadalongEvent): void {
  switch (event.event) {
    case 'start':
      set({ status: 'building', done: 0, total: event.clips });
      break;
    case 'download':
      set({ status: 'downloading', bytes: event.bytes, total: event.total });
      break;
    case 'clip':
      set({ status: 'building', done: event.done, total: event.total });
      break;
    case 'done':
      set({ status: 'done', matched: event.matched, total: event.clips });
      break;
    case 'error':
      set({ status: 'error', message: event.message });
      break;
  }
}
