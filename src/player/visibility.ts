// Pure rules that keep playback from re-rendering React when no frame is being drawn.
// Deliberately free of react-native/expo imports so it runs under the plain Node test runner
// (test/visibility.test.ts) like recovery.ts and position.ts.
//
// While the app is in the background the audio keeps playing but nothing is drawn. Every React
// render of the player still mounts native Animated nodes, and with no frame to attach them to
// (Android's didDispatchMountItems) they pile up until the heap is full. So the per-tick status
// fields are held in the player's refs and flushed once when the app becomes active again; only a
// change the user must see on return (a new chapter, an error, the sleep timer) goes through.

/** Player-state fields a playback status tick can move. Held in the refs while backgrounded. */
export const TICK_FIELDS = [
  'position', 'positionAt', 'seekPending', 'duration', 'playing', 'loading', 'recovering',
] as const;

/**
 * Whether a patch must be pushed to React now. In the foreground, always. In the background only
 * when it changes something outside {@link TICK_FIELDS} — a new chapter, an error, the sleep
 * timer, a freshly opened book. Purely tick-driven patches wait for the flush on becoming active.
 */
export function shouldPushUpdate(appActive: boolean, changed: readonly string[]): boolean {
  if (appActive) return true;
  const tick: readonly string[] = TICK_FIELDS;
  return changed.some((k) => !tick.includes(k));
}

/** How far the bar has to move before gliding to the new value is worth a 500 ms animation. */
export const PROGRESS_ANIMATE_EPSILON = 0.005; // 0.5% of the bar

/**
 * Whether a progress-bar change should animate. The playhead creeps forward every status tick, so
 * those small steps are set directly; a real jump still glides. Values are clamped to [0, 1].
 */
export function shouldAnimateProgress(prev: number, next: number): boolean {
  const a = Number.isFinite(prev) ? Math.max(0, Math.min(1, prev)) : 0;
  const b = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 0;
  return Math.abs(b - a) > PROGRESS_ANIMATE_EPSILON;
}
