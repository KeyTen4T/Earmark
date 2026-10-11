import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import { TBTorrent, TBFile, chapterList, chapterTitle, getStreamUrl } from '../torbox';
import { loadProgress, saveProgress, loadSettings, saveSettings, BookMeta } from '../storage';
import { prettyName } from '../theme';
import { syncProgress } from '../hardcover';
import { syncNow, syncAfterProgress, onSyncApplied } from '../sync';
import { decideRecovery, nextRecovery, recoverySettled, STALL_MS, type PlaybackSnapshot } from './recovery';
import { shouldPushUpdate } from './visibility';
import { detectJump, seekSettled } from './seekbase';
import { localUriFor, markFileForRedownload } from '../downloads';

type SleepMode = { kind: 'minutes'; endsAt: number } | { kind: 'chapter' } | null;

type PlayerState = {
  book: TBTorrent | null;
  meta: BookMeta;
  chapters: TBFile[];
  index: number;
  position: number;
  /** Wall-clock time (ms epoch) of the last position report or seek, for read-along extrapolation. */
  positionAt: number;
  /** True after a seek until the next player status lands; suppresses extrapolation in between. */
  seekPending: boolean;
  /**
   * Player-time (seconds) of the last seek/load for the current file, or null when it started at 0
   * and was never seeked. The Android read-along uses it to undo media3's Xing seek error.
   */
  seekBase: number | null;
  duration: number;
  playing: boolean;
  loading: boolean;
  /** True while a fresh stream link is being fetched after a stall (shows "Reconnecting…"). */
  recovering: boolean;
  /** True when the current chapter is playing from a downloaded file, so no link is involved. */
  local: boolean;
  rate: number;
  error: string;
  sleep: SleepMode;
  skipBack: number;
  skipForward: number;
};

type PlayerApi = PlayerState & {
  open: (book: TBTorrent, meta: BookMeta, opts?: { autoplay?: boolean; chapter?: number }) => Promise<void>;
  toggle: () => void;
  seek: (seconds: number) => void;
  skip: (delta: number) => void;
  goChapter: (i: number) => void;
  setRate: (r: number) => void;
  setSleep: (m: 'off' | 'chapter' | number) => void;
  setSkips: (back: number, forward: number) => void;
  stop: () => void;
  /** Refreshes the now-playing book's metadata (e.g. a new cover); ignored if another book is playing. */
  updateMeta: (bookId: number, m: BookMeta) => void;
  displayTitle: string;
  chapterName: string;
};

const Ctx = createContext<PlayerApi | null>(null);
export const usePlayer = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePlayer outside PlayerProvider');
  return c;
};

const LINK_TTL_MS = 2 * 60 * 60 * 1000; // re-request TorBox links older than this
const CHECK_INTERVAL_MS = 3_000; // how often the stall watchdog runs
const INTENT_GRACE_MS = 2_000; // ignore a brief "paused" right after we asked to play

export function PlayerProvider({ token, children }: { token: string; children: React.ReactNode }) {
  const [s, setS] = useState<PlayerState>({
    book: null, meta: {}, chapters: [], index: 0, position: 0, positionAt: 0, seekPending: false,
    seekBase: null,
    duration: 0, playing: false, loading: false,
    recovering: false, local: false, rate: 1, error: '', sleep: null, skipBack: 15, skipForward: 30,
  });
  const st = useRef(s);
  // Whether React is currently drawing. While the app is backgrounded the refs keep advancing but
  // setState is held back (see patch) so no Animated nodes are mounted with no frames to draw them.
  const appActive = useRef(AppState.currentState !== 'background');
  const player = useRef<AudioPlayer | null>(null);
  const pending = useRef<{ seek: number; play: boolean } | null>(null);
  const jsSeek = useRef<{ target: number; at: number } | null>(null); // a seek of ours that has not landed yet
  const linkTime = useRef(0);
  // Whether the current source is a downloaded file. A local file needs no link, so stream recovery
  // and the 2 h link-TTL reload must leave it alone.
  const localChapter = useRef(false);
  const lastSave = useRef(0);
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadToken = useRef(0);

  // ---- Stream recovery. User intent is tracked separately from what the player reports, so a
  // system interruption (which just pauses us) is never mistaken for a dead link. ----
  const wantPlaying = useRef(false);
  const wantPlayingSince = useRef(0); // when playback was last requested, for the interruption grace
  const lastSnapshot = useRef<PlaybackSnapshot | null>(null);
  const lastGoodPosition = useRef(0); // the last position worth resuming from
  const lastProgressAt = useRef(0); // when the position last moved forward
  const recovering = useRef(false);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryAttempts = useRef(0);
  const recoveryStartedAt = useRef(0);
  const recoveryAnchor = useRef(0); // position a recovery reload should beat
  const recoveryAdvancedAt = useRef(0);

  // The ref is the source of truth: background ticks update it without touching React, so playback
  // keeps advancing while the screen is off. React only re-renders when it can draw (or for a rare
  // change the user must see on return); the whole state is flushed when the app becomes active.
  const patch = (p: Partial<PlayerState>) => {
    const next = { ...st.current, ...p };
    st.current = next;
    if (shouldPushUpdate(appActive.current, Object.keys(p))) setS(next);
  };

  // seekBase changes only on a seek or a file load, never per tick, so it stays out of TICK_FIELDS.
  // A native seek detected while backgrounded must not push a render (the flush on return already
  // carries the whole ref), so update the ref always and push only while React can draw.
  const setSeekBase = (v: number | null) => {
    if (st.current.seekBase === v) return;
    st.current = { ...st.current, seekBase: v };
    if (appActive.current) setS(st.current);
  };

  const snapshot = (status: any): PlaybackSnapshot => ({
    position: status.currentTime ?? 0,
    duration: status.duration ?? 0,
    playing: !!status.playing,
    isBuffering: !!status.isBuffering,
    isLoaded: !!status.isLoaded,
    didJustFinish: !!status.didJustFinish,
    error: typeof status.error === 'string' && status.error ? status.error : null,
    playbackState: status.playbackState ?? '',
    timeControlStatus: status.timeControlStatus ?? '',
    reasonForWaitingToPlay: status.reasonForWaitingToPlay ?? '',
  });

  // Any user action cancels a pending recovery so it can't fight the new intent.
  function cancelRecovery() {
    if (recoveryTimer.current) { clearTimeout(recoveryTimer.current); recoveryTimer.current = null; }
    if (recovering.current || recoveryAttempts.current || recoveryStartedAt.current) {
      recovering.current = false;
      recoveryAttempts.current = 0;
      recoveryStartedAt.current = 0;
      recoveryAdvancedAt.current = 0;
      patch({ recovering: false });
    }
  }

  function giveUp() {
    if (recoveryTimer.current) { clearTimeout(recoveryTimer.current); recoveryTimer.current = null; }
    recovering.current = false;
    wantPlaying.current = false;
    recoveryAttempts.current = 0;
    recoveryStartedAt.current = 0;
    patch({ recovering: false, loading: false, error: 'Couldn’t reconnect to the stream.' });
  }

  function scheduleRecovery() {
    if (!wantPlaying.current || !st.current.book) return;
    if (localChapter.current) return; // a local file needs no fresh link
    if (recoveryTimer.current || recovering.current) return;
    const now = Date.now();
    if (!recoveryStartedAt.current) recoveryStartedAt.current = now;
    const plan = nextRecovery(recoveryAttempts.current, now - recoveryStartedAt.current);
    if (!plan) { giveUp(); return; }
    recovering.current = true;
    patch({ recovering: true, error: '' });
    recoveryTimer.current = setTimeout(() => {
      recoveryTimer.current = null;
      const snap = lastSnapshot.current;
      // The stream healed while we waited: forward progress and a healthy status mean no reload.
      const healed = lastProgressAt.current > now && !!snap && !snap.error && snap.playbackState !== 'idle';
      if (healed) { cancelRecovery(); return; }
      recoveryAttempts.current = plan.attempts;
      runRecovery();
    }, plan.delayMs);
  }

  function runRecovery() {
    const c = st.current;
    if (!c.book || !wantPlaying.current || !c.chapters[c.index]) { cancelRecovery(); return; }
    recoveryAnchor.current = lastGoodPosition.current;
    recoveryAdvancedAt.current = 0;
    lastSnapshot.current = null; // the stale error must not immediately queue another attempt
    const start = Math.max(0, lastGoodPosition.current - 2); // rewind a little to cover the gap
    void loadChapter(c.index, start, true);
  }

  // The watchdog: a status event tells us about errors at once, but a web stream can go quiet
  // without any event at all, so poll the last snapshot for a position that isn't moving.
  // Interruptions are left to the status listener, which sees the player's pause as it happens.
  function checkNow() {
    const c = st.current;
    if (!c.book || !wantPlaying.current) return;
    if (localChapter.current) return; // local playback is judged by the status listener, not the stall watchdog
    if (c.loading || pending.current) return;
    if (recoveryTimer.current) return;
    const stalledForMs = Date.now() - lastProgressAt.current;
    // A recovery reload can stall again before it settles; line up the next attempt.
    if (recovering.current) {
      if (stalledForMs >= STALL_MS) { recovering.current = false; scheduleRecovery(); }
      return;
    }
    const cur = lastSnapshot.current;
    if (!cur) return;
    const decision = decideRecovery({ wantPlaying: true, prev: null, cur, stalledForMs });
    if (decision === 'recover') scheduleRecovery();
  }

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' } as any).catch(() => {});
    loadSettings().then((x) => patch({ rate: x.rate, skipBack: x.skipBack, skipForward: x.skipForward }));
    const check = setInterval(checkNow, CHECK_INTERVAL_MS);
    return () => {
      // Pause before letting go: a released player can keep sounding in the background with nothing left to control it.
      clearInterval(check);
      if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
      try { player.current?.pause(); } catch { /* already gone */ }
      player.current?.remove();
      player.current = null;
      if (sleepTimer.current) clearTimeout(sleepTimer.current);
    };
  }, []);

  // Timers can be frozen while the app is backgrounded, so re-check as soon as we're foregrounded.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const active = next !== 'background';
      appActive.current = active;
      if (!active) return;
      const status = (player.current as any)?.currentStatus;
      if (status) {
        const pos = status.currentTime ?? 0;
        if (pos > lastGoodPosition.current + 0.25) {
          lastGoodPosition.current = pos;
          lastProgressAt.current = Date.now();
          lastSnapshot.current = snapshot(status);
        } else if (wantPlaying.current && Date.now() - wantPlayingSince.current > INTENT_GRACE_MS && !status.playing && !status.isBuffering && !status.error && !status.didJustFinish) {
          // The OS paused us while we were away (a call, another app took focus): don't fight it.
          wantPlaying.current = false;
          patch({ playing: false }); // active again, so this pushes the whole held-back state
          return;
        }
      }
      checkNow();
      // Push whatever the background ticks held back, so the UI shows the current position at once.
      setS(st.current);
    });
    return () => sub.remove();
  }, []);

  const persist = useCallback((force = false) => {
    const c = st.current;
    if (!c.book || !c.chapters.length) return;
    // A recovery reload can briefly report 0; never let that wipe out real progress.
    if (recovering.current && c.position <= 0) return;
    const now = Date.now();
    if (!force && now - lastSave.current < 5000) return;
    lastSave.current = now;
    const lastChapter = c.index === c.chapters.length - 1;
    const finished = lastChapter && c.duration > 0 && c.position >= c.duration - 2;
    void saveProgress(c.book.id, {
      fileId: c.chapters[c.index].id,
      chapterIndex: c.index,
      chapterCount: c.chapters.length,
      position: c.position,
      duration: c.duration,
      updated: now,
      finished,
    }).then(() => syncAfterProgress(force), () => {});
    if (c.duration > 0) {
      syncProgress(c.book.id, { sizes: c.chapters.map((f) => f.size), index: c.index, position: c.position, duration: c.duration }, finished, force);
    }
  }, []);

  const ensurePlayer = () => {
    if (player.current) return player.current;
    const p = createAudioPlayer(null);
    p.addListener('playbackStatusUpdate', (status: any) => {
      const snap = snapshot(status);
      // A seek we did not initiate (a lock-screen / notification / headset skip, handled natively by
      // expo-audio) shows up only as a jump in the reported position. Record it as the seek target
      // the read-along conversion needs. Not while a file is loading, recovering, or a seek of our
      // own has yet to land: a source reports 0 until its start position is applied, and reading
      // that as a jump would throw away the target we already recorded.
      const reportedNow = status.currentTime ?? 0;
      const ours = jsSeek.current;
      if (ours && seekSettled(ours.target, ours.at, reportedNow, Date.now(), st.current.rate)) jsSeek.current = null;
      if (!jsSeek.current && !pending.current && !recovering.current && status.isLoaded) {
        const jump = detectJump({
          position: st.current.position,
          at: st.current.positionAt,
          rate: st.current.rate,
          playing: st.current.playing,
          seekPending: st.current.seekPending,
        }, reportedNow, Date.now());
        if (jump.jumped) setSeekBase(jump.target);
      }
      const pend = pending.current;
      if (pend && status.isLoaded && (status.duration ?? 0) > 0) {
        pending.current = null;
        if (pend.seek > 1) {
          jsSeek.current = { target: pend.seek, at: Date.now() };
          p.seekTo(pend.seek).catch(() => {});
        }
        p.setPlaybackRate(st.current.rate);
        if (pend.play) p.play();
        patch({ loading: false });
      }
      // While a load/seek is pending trust the requested position. During a recovery reload a
      // source can report 0 before the seek lands, which must not clobber the last good position.
      let pos = pend && pend.seek > 1 ? pend.seek : status.currentTime ?? 0;
      if (recovering.current && (!Number.isFinite(pos) || pos <= 0)) pos = lastGoodPosition.current;
      snap.position = pos;
      const prev = lastSnapshot.current;

      // Forward progress is what separates a stall from normal playback.
      const progressed = Number.isFinite(pos) && pos > lastGoodPosition.current + 0.25;
      if (progressed) {
        lastGoodPosition.current = pos;
        lastProgressAt.current = Date.now();
      } else if (!lastProgressAt.current) {
        lastProgressAt.current = Date.now();
      }
      lastSnapshot.current = snap;

      // A downloaded file that won't play isn't a stream problem: fall back to the stream for this
      // chapter and forget the file so it can be fetched again.
      if (snap.error && localChapter.current) {
        const lc = st.current;
        const chapter = lc.chapters[lc.index];
        if (lc.book && chapter) {
          localChapter.current = false;
          markFileForRedownload(lc.book.hash, chapter.id);
          void loadChapter(lc.index, Math.max(0, lastGoodPosition.current - 2), wantPlaying.current, { forceStream: true });
        }
        return;
      }

      // The stream healed on its own while a retry was pending: stand the recovery down.
      if (progressed && recoveryTimer.current && !snap.error && snap.playbackState !== 'idle') {
        cancelRecovery();
      }

      patch({
        position: pos,
        positionAt: Date.now(),
        seekPending: false,
        duration: status.duration ?? 0,
        playing: !!status.playing,
      });

      if (status.didJustFinish) {
        const c = st.current;
        const hasNext = c.index < c.chapters.length - 1;
        if (!hasNext) {
          st.current = { ...c, position: status.duration ?? c.position, playing: false };
          wantPlaying.current = false;
          patch({ playing: false });
          persist(true);
        } else {
          persist(true); // a chapter change is worth syncing straight away
          if (c.sleep?.kind === 'chapter') {
            wantPlaying.current = false;
            patch({ sleep: null });
            loadChapter(c.index + 1, 0, false); // queue next chapter, paused
          } else {
            wantPlaying.current = true;
            loadChapter(c.index + 1, 0, true);
          }
        }
        return;
      }

      persist();

      // Recovery is judged first: a failed reload reports an error while a load is still pending,
      // and must hand off to the backoff schedule rather than be skipped.
      if (recovering.current) {
        if (snap.error) {
          // The fresh source failed too: hand off to the backoff schedule.
          recovering.current = false;
          scheduleRecovery();
          return;
        }
        if (!pend && !st.current.loading && pos > recoveryAnchor.current + 1) {
          if (!recoveryAdvancedAt.current) recoveryAdvancedAt.current = Date.now();
          if (recoverySettled(recoveryAnchor.current, pos, Date.now() - recoveryAdvancedAt.current)) {
            recoveryAttempts.current = 0;
            recoveryStartedAt.current = 0;
            recoveryAdvancedAt.current = 0;
            recovering.current = false;
            patch({ recovering: false });
          }
        }
        return;
      }

      // Only judge the stream once a load is done and no seek is pending.
      if (pend || st.current.loading) return;
      if (wantPlaying.current) {
        const decision = decideRecovery({ wantPlaying: true, prev, cur: snap, stalledForMs: Date.now() - lastProgressAt.current });
        if (decision === 'recover') scheduleRecovery();
        else if (decision === 'interrupted' && Date.now() - wantPlayingSince.current > INTENT_GRACE_MS) {
          wantPlaying.current = false;
          patch({ playing: false }); // active again, so this pushes the whole held-back state
          return;
        }
      }
    });
    player.current = p;
    return p;
  };

  const loadChapter = async (i: number, startAt: number, autoplay: boolean, opts?: { forceStream?: boolean }) => {
    const c = st.current;
    if (!c.book || !c.chapters[i]) return;
    const my = ++loadToken.current;
    // A fresh load carries the user's intent and a new progress anchor (recovery keeps its own).
    wantPlaying.current = autoplay;
    if (autoplay) wantPlayingSince.current = Date.now();
    lastProgressAt.current = Date.now();
    if (!recovering.current) lastGoodPosition.current = startAt;
    // A file loaded at 0 was never seeked (no Xing error to undo); a resume/recovery load is a seek.
    setSeekBase(startAt > 1 ? startAt : null); // same threshold as the seek applied once it loads
    patch({ index: i, position: startAt, positionAt: Date.now(), seekPending: true, duration: 0, loading: true, error: '' });
    try {
      // A finished chapter plays from disk with no link and no network. Anything else streams.
      const local = opts?.forceStream ? null : localUriFor(c.book.hash, c.chapters[i].id);
      localChapter.current = !!local;
      patch({ local: !!local });
      const url = local ?? await getStreamUrl(token, c.book.id, c.chapters[i].id);
      if (my !== loadToken.current) return; // a newer request superseded this one
      if (!local) linkTime.current = Date.now();
      const p = ensurePlayer();
      pending.current = { seek: startAt, play: autoplay };
      p.replace({ uri: url });
      const lock = (p as any).setActiveForLockScreen;
      if (typeof lock === 'function') {
        lock.call(p, true, {
          title: chapterTitle(c.chapters[i]),
          artist: c.meta.author ?? c.meta.title ?? prettyName(c.book.name),
          albumTitle: c.meta.title ?? prettyName(c.book.name),
          artworkUrl: c.meta.cover,
        });
      }
      // Fallback in case no "loaded" status arrives (some formats report late).
      setTimeout(() => {
        if (my === loadToken.current && pending.current) {
          const pend = pending.current;
          pending.current = null;
          if (pend.seek > 1) p.seekTo(pend.seek).catch(() => {});
          p.setPlaybackRate(st.current.rate);
          if (pend.play) p.play();
          patch({ loading: false });
        }
      }, 4000);
    } catch (e: any) {
      if (my === loadToken.current) {
        patch({ loading: false, error: e?.message ?? 'Could not load chapter' });
        // A recovery reload that can't even fetch a link should line up the next attempt.
        if (recovering.current) { recovering.current = false; scheduleRecovery(); }
      }
    }
  };

  // A sync can bring a newer position from another device. Adopt it only when this book is loaded
  // and paused: while playing, the local position is the one that should win on the next save.
  useEffect(() => onSyncApplied(() => {
    const c = st.current;
    if (!c.book || c.playing || !c.chapters.length) return;
    void loadProgress().then((all) => {
      const cur = st.current;
      if (!cur.book || cur.playing) return;
      const saved = all[String(cur.book.id)];
      if (!saved || saved.finished || saved.updated <= lastSave.current) return; // not newer than our last save
      const found = cur.chapters.findIndex((ch) => ch.id === saved.fileId);
      const moved = found !== cur.index || Math.abs((saved.position ?? 0) - cur.position) > 5;
      if (moved) loadChapter(found >= 0 ? found : cur.index, found >= 0 ? Math.max(0, saved.position - 3) : cur.position, false);
    });
  }), []);

  // A sync can also bring new playback settings from another device. Adopt any that actually changed
  // and apply a new rate to the audio already loaded, the same way a manual rate change does.
  useEffect(() => onSyncApplied(() => {
    void loadSettings().then((x) => {
      const c = st.current;
      if (x.rate === c.rate && x.skipBack === c.skipBack && x.skipForward === c.skipForward) return;
      if (x.rate !== c.rate) player.current?.setPlaybackRate(x.rate);
      patch({ rate: x.rate, skipBack: x.skipBack, skipForward: x.skipForward });
    });
  }), []);

  const open: PlayerApi['open'] = async (book, meta, opts = {}) => {
    cancelRecovery();
    wantPlaying.current = false;
    persist(true);
    // A quick sync first, so a newer position from another device is picked up — but never let a slow
    // network hold up playback: syncNow gives up after a couple of seconds.
    await syncNow({ timeoutMs: 2500 });
    const chapters = chapterList(book);
    if (!chapters.length) { patch({ error: 'No audio files in this torrent' }); return; }
    const saved = (await loadProgress())[String(book.id)];
    let idx = opts.chapter ?? 0;
    let start = 0;
    if (opts.chapter === undefined && saved && !saved.finished) {
      const found = chapters.findIndex((c) => c.id === saved.fileId);
      if (found >= 0) { idx = found; start = Math.max(0, saved.position - 3); } // rewind slightly on resume
    }
    if (st.current.book?.id === book.id && opts.chapter === undefined) {
      if (opts.autoplay && !st.current.playing) {
        wantPlaying.current = true;
        wantPlayingSince.current = Date.now();
        lastProgressAt.current = Date.now();
        player.current?.play();
      }
      return;
    }
    player.current?.pause();
    st.current = { ...st.current, book, meta, chapters };
    patch({ book, meta, chapters });
    saveSettings({ lastBookId: book.id });
    await loadChapter(idx, start, opts.autoplay ?? true);
  };

  const toggle = () => {
    const p = player.current;
    const c = st.current;
    if (!c.book) return;
    // No player (it was released under us): rebuild it where we left off rather than leave the button dead.
    if (!p) { cancelRecovery(); wantPlaying.current = true; wantPlayingSince.current = Date.now(); lastProgressAt.current = Date.now(); loadChapter(c.index, c.position, !c.playing); return; }
    // Ask the player itself; the last status update we saw can be out of date.
    if (p.playing || c.playing) { wantPlaying.current = false; cancelRecovery(); p.pause(); patch({ playing: false }); persist(true); return; }
    cancelRecovery();
    wantPlaying.current = true;
    wantPlayingSince.current = Date.now();
    lastProgressAt.current = Date.now();
    if (!localChapter.current && Date.now() - linkTime.current > LINK_TTL_MS) { loadChapter(c.index, c.position, true); return; }
    p.play();
  };

  const seek = (sec: number) => {
    const c = st.current;
    const t = Math.max(0, Math.min(c.duration || sec, sec));
    cancelRecovery(); // a user seek wins over any pending recovery position
    lastGoodPosition.current = t;
    lastProgressAt.current = Date.now();
    setSeekBase(t);
    jsSeek.current = { target: t, at: Date.now() };
    patch({ position: t, positionAt: Date.now(), seekPending: true });
    player.current?.seekTo(t).catch(() => {});
  };

  const skip = (d: number) => seek(st.current.position + d);

  const goChapter = (i: number) => {
    const c = st.current;
    if (i < 0 || i >= c.chapters.length) return;
    cancelRecovery();
    persist(true);
    loadChapter(i, 0, true);
  };

  const setRate = (r: number) => {
    patch({ rate: r });
    player.current?.setPlaybackRate(r);
    saveSettings({ rate: r });
  };

  const setSleep: PlayerApi['setSleep'] = (m) => {
    if (sleepTimer.current) clearTimeout(sleepTimer.current);
    sleepTimer.current = null;
    if (m === 'off') return patch({ sleep: null });
    if (m === 'chapter') return patch({ sleep: { kind: 'chapter' } });
    const ms = m * 60 * 1000;
    patch({ sleep: { kind: 'minutes', endsAt: Date.now() + ms } });
    sleepTimer.current = setTimeout(() => {
      wantPlaying.current = false;
      cancelRecovery();
      player.current?.pause();
      persist(true);
      patch({ sleep: null });
    }, ms);
  };

  const setSkips = (back: number, forward: number) => {
    patch({ skipBack: back, skipForward: forward });
    saveSettings({ skipBack: back, skipForward: forward });
  };

  const stop = () => {
    wantPlaying.current = false;
    localChapter.current = false;
    cancelRecovery();
    persist(true);
    player.current?.pause();
    const lock = (player.current as any)?.clearLockScreenControls;
    if (typeof lock === 'function') lock.call(player.current);
    setSeekBase(null);
    patch({ book: null, chapters: [], playing: false, recovering: false, local: false });
  };

  const updateMeta = (bookId: number, m: BookMeta) => {
    if (st.current.book?.id === bookId) patch({ meta: { ...st.current.meta, ...m } });
  };

  const value = useMemo<PlayerApi>(() => ({
    ...s, open, toggle, seek, skip, goChapter, setRate, setSleep, setSkips, stop, updateMeta,
    displayTitle: s.book ? s.meta.title ?? prettyName(s.book.name) : '',
    chapterName: s.chapters[s.index] ? chapterTitle(s.chapters[s.index]) : '',
  }), [s]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
