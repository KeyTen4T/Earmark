// Idle "immersive reading" chrome: the timings, and the one non-trivial decision — whether a tap on
// a paragraph may seek. Pure: no react-native imports, so the Node test runner covers it (the hook
// that runs the timers and the fade lives in PlayerScreen.tsx).

/** No input for this long hides the player's chrome while the read-along text is showing. */
export const CHROME_IDLE_MS = 6000;
/** Fade-out when the chrome is hidden, and fade-in when any input brings it back. */
export const CHROME_HIDE_MS = 350;
export const CHROME_SHOW_MS = 180;
/** After the chrome is revealed, a paragraph tap is ignored for this long. */
export const CHROME_SEEK_GUARD_MS = 500;

/**
 * Whether a tap on a paragraph may seek. It may not when the chrome was hidden at the moment the
 * touch began — that touch's job is to bring the chrome back — nor within `guard` ms of a reveal,
 * so the tap that reveals the chrome never also jumps the audio.
 */
export function seekAllowed(
  chromeHiddenAtTouchStart: boolean,
  revealedAt: number,
  now: number,
  guard = CHROME_SEEK_GUARD_MS,
): boolean {
  if (chromeHiddenAtTouchStart) return false;
  return now - revealedAt >= guard;
}
