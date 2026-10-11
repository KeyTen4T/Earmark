// Pure rules for the read-along's seek map: tracking the player-time the current file was last
// seeked to, and converting between player time and true audio time at the read-along boundary.
// No react-native/expo imports, so it runs under the plain Node test runner (test/seekbase.test.ts).
//
// A XingSeeker-style TOC seek can land minutes away from the time a seek asked for, so on the
// platforms with a modelled player the read-along works in true audio time: the highlight follows
// `readalongTime` and tapping a paragraph seeks with `readalongSeekTarget`. The model is 'media3' on
// Android and 'ffmpeg' on the Chromium/web player; null means no correction (every other platform
// and every other consumer of the player's position keeps the reported time unchanged). `seekBase`
// is the player-time of the last seek/load the file has had (null when it started at 0 and was
// never seeked).

import { playerToTrue, trueToSeekTarget, type SeekModel, type XingSeekMap } from '../readalong/mp3seek';

/** A report this far from where playback should be is a seek we did not initiate. */
export const JUMP_THRESHOLD_SECONDS = 1.5;

export type JumpState = {
  /** Last position the player reported (or a seek asked for), in seconds. */
  position: number;
  /** Wall-clock ms when `position` was set. */
  at: number;
  rate: number;
  playing: boolean;
  /** A JS seek/load is pending; its target is already recorded, so its report must not be re-read. */
  seekPending: boolean;
};

export type Jump = { jumped: boolean; target: number };

/**
 * Whether a status report is a seek JS did not initiate (a lock-screen / notification / headset
 * skip, which expo-audio handles in native code and never reports to JS), and the player-time it
 * landed on. While a JS seek is pending the report is ignored: that seek already recorded its
 * target and must not be overwritten by the position the player happens to report next.
 *
 * Playback can only fall behind the clock (a stall, buffering, the OS holding the audio), never run
 * ahead of it or go backwards, so only those two count: a report earlier than the last one, or
 * further on than the elapsed time allows. A stream that stalls is not a seek.
 */
export function detectJump(state: JumpState, reported: number, now: number): Jump {
  if (state.seekPending) return { jumped: false, target: reported };
  const elapsed = Math.max(0, now - state.at) / 1000;
  const furthest = state.position + (state.playing ? elapsed * state.rate : 0);
  const jumped = reported < state.position - JUMP_THRESHOLD_SECONDS
    || reported > furthest + JUMP_THRESHOLD_SECONDS;
  return { jumped, target: reported };
}

/** How long a seek JS asked for may take to show up in the reported position. */
export const SEEK_SETTLE_MS = 8_000;

/**
 * Whether a seek JS asked for has landed: the player now reports a position at the target or as far
 * past it as the time since allows. Until then (a source that still reports 0 while it loads, or
 * the old position for a tick) reports must not be read as jumps. Gives up after
 * {@link SEEK_SETTLE_MS} so a seek that never lands cannot switch detection off for good.
 */
export function seekSettled(target: number, askedAt: number, reported: number, now: number, rate: number): boolean {
  const waited = Math.max(0, now - askedAt);
  if (waited > SEEK_SETTLE_MS) return true;
  return reported >= target - JUMP_THRESHOLD_SECONDS
    && reported <= target + (waited / 1000) * Math.max(rate, 1) + JUMP_THRESHOLD_SECONDS;
}

/**
 * The true audio time the read-along should highlight. With a model, a seek map and a known seek
 * target, this undoes the player's TOC-based seek error; with no model (or no map/seek) it is the
 * reported time.
 */
export function readalongTime(
  map: XingSeekMap | null | undefined,
  model: SeekModel | null | undefined,
  seekBase: number | null | undefined,
  reported: number,
): number {
  if (!model || !map) return reported;
  return playerToTrue(map, seekBase, reported, model);
}

/**
 * The player-time to seek to so the narrator really starts at `trueTime`. With a model and a seek
 * map this is the inverse of {@link readalongTime}; otherwise `trueTime` is returned as is.
 */
export function readalongSeekTarget(
  map: XingSeekMap | null | undefined,
  model: SeekModel | null | undefined,
  trueTime: number,
): number {
  if (!model || !map) return trueTime;
  return trueToSeekTarget(map, trueTime, model);
}
