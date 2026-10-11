import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideRecovery, nextRecovery, recoverySettled,
  STALL_MS, RECOVERY_MAX_MS, RECOVERY_DELAYS_MS,
  type PlaybackSnapshot,
} from '../src/player/recovery';

const snap = (over: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot => ({
  position: 100, duration: 600, playing: true, isBuffering: false, isLoaded: true,
  didJustFinish: false, error: null, playbackState: 'ready', timeControlStatus: 'playing',
  reasonForWaitingToPlay: '', ...over,
});

test('recovery: stalling while buffering triggers recovery', () => {
  const prev = snap();
  const cur = snap({ position: 100, isBuffering: true, playbackState: 'buffering' });
  assert.equal(decideRecovery({ wantPlaying: true, prev, cur, stalledForMs: STALL_MS + 1 }), 'recover');
});

test('recovery: an error status triggers recovery', () => {
  const cur = snap({ playing: false, error: '403 Forbidden', isLoaded: false, playbackState: 'idle' });
  assert.equal(decideRecovery({ wantPlaying: true, prev: snap(), cur, stalledForMs: 0 }), 'recover');
});

test('recovery: a source unloaded under us triggers recovery without an error', () => {
  const cur = snap({ playing: false, isLoaded: false, playbackState: 'idle' });
  assert.equal(decideRecovery({ wantPlaying: true, prev: snap(), cur, stalledForMs: 0 }), 'recover');
});

test('recovery: a rebuffer under 15s is not treated as an unloaded source', () => {
  // Android clears isLoaded for READY -> BUFFERING (AudioPlayer.kt), which must not look fatal.
  const prev = snap({ playbackState: 'ready', isLoaded: true });
  const cur = snap({ playbackState: 'buffering', isBuffering: true, isLoaded: false, playing: true });
  assert.equal(decideRecovery({ wantPlaying: true, prev, cur, stalledForMs: 5_000 }), 'none');
});

test('recovery: a rebuffer held for 15s recovers', () => {
  const prev = snap({ playbackState: 'ready', isLoaded: true });
  const cur = snap({ playbackState: 'buffering', isBuffering: true, isLoaded: false, playing: true });
  assert.equal(decideRecovery({ wantPlaying: true, prev, cur, stalledForMs: STALL_MS }), 'recover');
});

test('recovery: an idle source recovers even with no error and no previous load', () => {
  const idle = snap({ playbackState: 'idle', isLoaded: false, playing: false, isBuffering: false });
  assert.equal(decideRecovery({ wantPlaying: true, prev: snap({ playbackState: 'buffering', isBuffering: true, isLoaded: false }), cur: idle, stalledForMs: 0 }), 'recover');
  assert.equal(decideRecovery({ wantPlaying: true, prev: null, cur: idle, stalledForMs: 0 }), 'recover');
});

test('recovery: a pause with the source still ready is an interruption', () => {
  const cur = snap({ playbackState: 'ready', isLoaded: true, playing: false, timeControlStatus: 'paused' });
  assert.equal(decideRecovery({ wantPlaying: true, prev: snap(), cur, stalledForMs: 1_000 }), 'interrupted');
});

test('recovery: a stalled web player that still claims to be playing triggers recovery', () => {
  // Web hard-codes isBuffering false and emits no waiting events, so a stall looks like this there.
  const cur = snap({ isBuffering: false, playing: true, playbackState: '', timeControlStatus: 'playing' });
  assert.equal(decideRecovery({ wantPlaying: true, prev: snap(), cur, stalledForMs: STALL_MS }), 'recover');
});

test('recovery: a plain pause while we still want sound is an interruption, not recovery', () => {
  const cur = snap({ playing: false, timeControlStatus: 'paused' });
  assert.equal(decideRecovery({ wantPlaying: true, prev: snap(), cur, stalledForMs: 1_000 }), 'interrupted');
});

test('recovery: a user pause does nothing', () => {
  const cur = snap({ playing: false, timeControlStatus: 'paused' });
  assert.equal(decideRecovery({ wantPlaying: false, prev: snap(), cur, stalledForMs: 1_000 }), 'none');
});

test('recovery: reaching the end of a chapter does nothing', () => {
  const cur = snap({ playing: false, didJustFinish: true });
  assert.equal(decideRecovery({ wantPlaying: true, prev: snap(), cur, stalledForMs: 0 }), 'none');
});

test('recovery: backoff escalates and gives up after the cap', () => {
  assert.equal(nextRecovery(0, 0)!.delayMs, RECOVERY_DELAYS_MS[0]);
  assert.equal(nextRecovery(1, 2_000)!.delayMs, RECOVERY_DELAYS_MS[1]);
  assert.equal(nextRecovery(2, 7_000)!.delayMs, RECOVERY_DELAYS_MS[2]);
  assert.equal(nextRecovery(3, 22_000)!.delayMs, RECOVERY_DELAYS_MS[3]);
  assert.equal(nextRecovery(4, 52_000)!.delayMs, RECOVERY_DELAYS_MS[4]);
  assert.equal(nextRecovery(9, 500_000)!.delayMs, RECOVERY_DELAYS_MS[4]); // then every 60s
  assert.equal(nextRecovery(10, RECOVERY_MAX_MS - 1)!.attempts, 11);
  assert.equal(nextRecovery(11, RECOVERY_MAX_MS), null);
  assert.equal(nextRecovery(0, RECOVERY_MAX_MS + 1), null);
});

test('recovery: forward progress resets the backoff', () => {
  // Once playback has run past the recovery point for PROGRESS_RESET_MS, the counter is zeroed and
  // the next failure starts back at the short delay.
  assert.ok(recoverySettled(100, 103, 5_000));
  assert.ok(!recoverySettled(100, 100.5, 20_000)); // not enough forward progress
  assert.ok(!recoverySettled(100, 103, 2_000)); // not settled long enough
  assert.equal(nextRecovery(0, 0)!.delayMs, RECOVERY_DELAYS_MS[0]);
});
