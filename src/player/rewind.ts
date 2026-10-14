// How far playback should jump back when it resumes after a pause: the longer the listener was
// away, the more context they need to re-catch the thread. Deliberately free of react-native/expo
// imports so it runs under the plain Node test runner (test/rewind.test.ts).

/** Below this pause length the rewind is not worth a jump. */
export const REWIND_MIN_PAUSE_MS = 5_000;

/**
 * Seconds to go back when playback resumes after being paused for `pausedMs` milliseconds:
 * under 5 s nothing, then 2 s, 5 s, 10 s and 20 s as the pause grows. A non-finite or negative
 * value is treated as no pause.
 */
export function rewindFor(pausedMs: number): number {
  if (!(pausedMs >= REWIND_MIN_PAUSE_MS)) return 0; // < 5 s, or NaN
  if (pausedMs < 60_000) return 2;
  if (pausedMs < 5 * 60_000) return 5;
  if (pausedMs < 60 * 60_000) return 10;
  return 20;
}

/**
 * The position to resume at: `position` seconds back by {@link rewindFor}, never before the start
 * of the current chapter file (0). `position` is clamped too, so a stray negative cannot escape.
 */
export function rewindPosition(position: number, pausedMs: number): number {
  return Math.max(0, position - rewindFor(pausedMs));
}
