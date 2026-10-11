// The pure half of stream recovery: decides whether a player status snapshot means the stream
// needs a fresh link, the listener was interrupted, or nothing at all, plus the retry schedule.
// Deliberately free of React Native and Expo imports so it runs under the plain Node test runner
// (test/recovery.test.ts) and can be reasoned about on its own.
//
// Signals that really exist, per platform (see expo-audio's AudioPlayer.kt / BaseAudioPlayer.kt
// and AudioPlayer.web.ts / AudioUtils.web.ts):
//   Android (ExoPlayer): error (one-shot on onPlayerError), isBuffering / playbackState
//     ('buffering', 'idle', 'ready', 'ended'), isLoaded, playing, didJustFinish.
//   Web (Electron/Chromium): error (media.onerror only), didJustFinish (media.ended), position.
//     isBuffering is hard-coded false, playbackState is '', and there are no waiting/stalled
//     events, so a network stall shows up as a "playing" snapshot whose position never moves.

/** The parts of an AudioStatus that recovery cares about. */
export type PlaybackSnapshot = {
  /** Current position in seconds. */
  position: number;
  /** Total duration in seconds, or 0 if unknown. */
  duration: number;
  /** Whether the player considers itself playing. */
  playing: boolean;
  /** Android reports this; web hard-codes false. */
  isBuffering: boolean;
  /** Whether a source is loaded and ready. */
  isLoaded: boolean;
  /** Whether the current file reached its end. */
  didJustFinish: boolean;
  /** Playback error message, or null. */
  error: string | null;
  /** Android: 'idle' | 'buffering' | 'ready' | 'ended' | 'unknown'; web: ''. */
  playbackState: string;
  /** 'playing' | 'paused' | 'waiting…' depending on platform. */
  timeControlStatus: string;
  /** iOS/Android reason the player is waiting to play; empty when there isn't one. */
  reasonForWaitingToPlay: string;
};

export type RecoveryDecision = 'none' | 'recover' | 'interrupted';

export type RecoveryInput = {
  /** The user (or auto-advance) wants this chapter playing. */
  wantPlaying: boolean;
  /** The previous status snapshot, or null when there wasn't one. */
  prev: PlaybackSnapshot | null;
  /** The current status snapshot. */
  cur: PlaybackSnapshot;
  /** Milliseconds since the position last moved forward. */
  stalledForMs: number;
};

/** How long the position may sit still before we call it a stall. */
export const STALL_MS = 15_000;

/** Delay before each recovery attempt. After the list is exhausted we keep retrying at 60s. */
export const RECOVERY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** Stop trying after this long and hand back to the existing manual retry. */
export const RECOVERY_MAX_MS = 10 * 60_000;

/** How long playback must keep moving forward before recovery is considered a success. */
export const PROGRESS_RESET_MS = 5_000;

/**
 * The backoff entry for the next attempt: how long to wait, and the attempt count to carry into
 * that attempt. Null once the overall 10-minute cap has passed and we should give up.
 */
export function nextRecovery(attempts: number, elapsedMs: number): { delayMs: number; attempts: number } | null {
  if (elapsedMs >= RECOVERY_MAX_MS) return null;
  const delayMs = RECOVERY_DELAYS_MS[Math.min(attempts, RECOVERY_DELAYS_MS.length - 1)];
  return { delayMs, attempts: attempts + 1 };
}

/**
 * Whether resumed playback has run past the recovery point for long enough to reset the backoff.
 * `sinceProgressMs` is the time since the position first moved ahead of the recovery point.
 */
export function recoverySettled(anchorPosition: number, position: number, sinceProgressMs: number): boolean {
  return position > anchorPosition + 1 && sinceProgressMs >= PROGRESS_RESET_MS;
}

/**
 * Classifies a status snapshot. Only stream trouble returns 'recover'; a bare pause while the user
 * still wants sound is 'interrupted' (a call, another app taking focus) and must not be fought.
 */
export function decideRecovery(input: RecoveryInput): RecoveryDecision {
  const { wantPlaying, prev, cur, stalledForMs } = input;
  if (!wantPlaying) return 'none'; // the user doesn't want playback
  if (cur.didJustFinish) return 'none'; // normal end of chapter/book; auto-advance handles it
  if (cur.error) return 'recover'; // the stream reported an error
  // Android drops the source (playbackState 'idle') on a fatal error and after onPlayerError. That
  // is checked before the interruption rule so the idle status can't clear wantPlaying first.
  if (cur.playbackState === 'idle') return 'recover';
  // A genuinely unloaded source, but never a rebuffer: READY -> BUFFERING also clears isLoaded on
  // Android, so buffering must fall through to the 15 s stall rule below.
  if (prev?.isLoaded && !cur.isLoaded && !cur.isBuffering && cur.playbackState !== 'buffering') return 'recover';
  const waiting = cur.isBuffering || /wait/i.test(cur.timeControlStatus) || !!cur.reasonForWaitingToPlay;
  // Android reports buffering while it stalls; web keeps claiming 'playing' with no progress.
  if (stalledForMs >= STALL_MS && (waiting || cur.playing)) return 'recover';
  if (!cur.playing && !waiting) return 'interrupted'; // plain pause while we wanted sound
  return 'none';
}
