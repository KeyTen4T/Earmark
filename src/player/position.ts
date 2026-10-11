// Estimate where playback is *now* between player status updates, for the read-along highlight.
// Pure (no react-native/expo imports) so it runs under the plain Node test runner.
//
// The player reports a position every few hundred milliseconds. The read-along view ticks faster
// than that, so it extrapolates from the last report at the playback rate — but only for a short,
// bounded window and only while it is safe to do so.

/** What the view needs to estimate the current position. */
export type PositionClock = {
  /** The last position reported by the player, in seconds. */
  position: number;
  /** Wall-clock time (ms epoch) when `position` was reported (or a seek was requested). */
  at: number;
  /** Playback rate. */
  rate: number;
  /** Whether the player says it is playing. */
  playing: boolean;
  /** A load is in progress. */
  loading: boolean;
  /** A fresh stream link is being fetched after a stall. */
  recovering: boolean;
  /** A seek was requested and no player status has landed since. */
  seekPending: boolean;
};

/** Never run more than this far ahead of the last reported position. */
export const MAX_EXTRAPOLATION_SECONDS = 1.5;

/**
 * The best estimate of the current playback position, in seconds.
 *
 * Extrapolates `position + elapsed * rate` while playing, capped at {@link MAX_EXTRAPOLATION_SECONDS}.
 * Never extrapolates while paused, loading, recovering, or between a seek and the next status; in
 * those cases the last reported position is returned unchanged.
 */
export function extrapolatePosition(clock: PositionClock, now: number): number {
  if (!clock.playing || clock.loading || clock.recovering || clock.seekPending) return clock.position;
  const elapsedMs = now - clock.at;
  if (!(elapsedMs > 0)) return clock.position;
  const ahead = Math.min((elapsedMs / 1000) * clock.rate, MAX_EXTRAPOLATION_SECONDS);
  return clock.position + ahead;
}
