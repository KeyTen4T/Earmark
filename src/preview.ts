// The pure half of the "narrator preview": the decisions (can this result be previewed, which file
// to play, where to start, when to give up, and above all when a preview may delete the torrent it
// added) plus a small controller that runs the steps with injected TorBox calls, a player factory
// and a timer. Deliberately free of React Native and Expo imports so the Node test runner
// (test/preview.test.ts) drives it with fakes.
//
// TorBox can only stream files that are already in the account, so a preview temporarily adds the
// torrent. The safety rule: a preview may delete a torrent ONLY when the account list it read before
// adding did not contain the hash, its own addMagnet returned a torrent_id, and the user did not tap
// Add. A torrent that was already there is played from as it is and never deleted.

import type { TBTorrent, TBFile } from './torbox';
import { chapterList, isReady } from './torbox';
import { hashFromMagnet } from './scrapers/bencode';

export const PREVIEW_POLL_MS = 2_000;
/** How long to wait for TorBox to finish preparing the added torrent. */
export const PREVIEW_WAIT_MS = 40_000;
/** How long the preview plays before it stops itself. */
export const PREVIEW_MAX_MS = 75_000;
/** Skip the opening of a long file, so the preview lands somewhere a narrator is talking. */
export const PREVIEW_SKIP_S = 45;
export const PREVIEW_SKIP_MIN_S = 5 * 60;

export type PreviewInput = {
  /** The search result's row id, so Add only keeps the preview it belongs to. */
  id: string;
  hash?: string;
  magnet: string;
  title: string;
  narrator?: string;
};

/** A result can be previewed only when TorBox already has it cached (INSTANT) and it has a hash. */
export function canPreview(r: { infoHash?: string; magnet?: string }, cached: boolean): boolean {
  return cached && !!(r.infoHash || r.magnet);
}

/** A magnet built from a bare info hash, for a result that has no magnet of its own. */
export function magnetFor(hash: string | undefined, title: string): string | undefined {
  return hash ? `magnet:?xt=urn:btih:${hash.toLowerCase()}&dn=${encodeURIComponent(title)}` : undefined;
}

/** The file a preview plays: the first audio file in chapter order. */
export function previewFile(t: TBTorrent): TBFile | undefined {
  return chapterList(t)[0];
}

/** Where to start: skip the opening only when the file is long enough that 45 seconds don't matter. */
export function startOffset(duration: number): number {
  return duration >= PREVIEW_SKIP_MIN_S ? PREVIEW_SKIP_S : 0;
}

/** Polling gives up after PREVIEW_WAIT_MS have passed since it began. */
export function pollExpired(startedAt: number, now: number): boolean {
  return now - startedAt >= PREVIEW_WAIT_MS;
}

export type DeleteDecision = {
  /** The step-2 account fetch succeeded. */
  listOk: boolean;
  /** That fetch already listed the result's hash. */
  wasListed: boolean;
  /** The torrent_id this preview's own addMagnet returned, if it added one. */
  torrentId: number | null;
  /** The user tapped Add for it. */
  kept: boolean;
};

/**
 * The one case in which a preview's cleanup may delete: it added the torrent itself, the account did
 * not already have it, and the user did not keep it. Everything else plays from as it is.
 */
export function shouldDeleteOnCleanup(d: DeleteDecision): boolean {
  return d.listOk && !d.wasListed && d.torrentId != null && !d.kept;
}

// ---- The controller ----

export type PreviewPhase = 'off' | 'preparing' | 'playing';
export type PreviewState = { phase: PreviewPhase; elapsed: number };

export type PreviewStatus = { duration: number; position: number; didJustFinish: boolean; error: string | null };

export type PreviewPlayer = {
  play(): void;
  pause(): void;
  remove(): void;
  seekTo(seconds: number): void;
};

/** The clock, injected so tests can advance time and run scheduled work on demand. */
export type PreviewTimer = {
  now(): number;
  after(ms: number, fn: () => void): () => void;
  every(ms: number, fn: () => void): () => void;
};

export const systemTimer: PreviewTimer = {
  now: () => Date.now(),
  after: (ms, fn) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
  every: (ms, fn) => { const id = setInterval(fn, ms); return () => clearInterval(id); },
};

export type PreviewDeps = {
  listTorrents: () => Promise<TBTorrent[]>;
  addMagnet: (magnet: string, name?: string) => Promise<{ torrent_id?: number; queued_id?: number; hash: string }>;
  getStreamUrl: (torrentId: number, fileId: number) => Promise<string>;
  deleteTorrent: (torrentId: number) => Promise<void>;
  createPlayer: (uri: string, onStatus: (s: PreviewStatus) => void) => PreviewPlayer;
  toast: (text: string, kind?: 'ok' | 'err') => void;
  onState: (s: PreviewState) => void;
  timer?: PreviewTimer;
  /** How the poll waits between tries; tests resolve it at once and move the clock on. */
  sleep?: (ms: number) => Promise<void>;
};

/** What the preview added, handed back to Add so it can reuse the torrent instead of adding again. */
export type PreviewHandoff = { hash?: string; torrentId?: number };

export type PreviewController = {
  start(input: PreviewInput): Promise<void>;
  /** Add was tapped for this result: keep the preview's torrent and stop the audio. Null when this preview added nothing to reuse. */
  keep(id: string): PreviewHandoff | null;
  stop(): void;
};

const OFF: PreviewState = { phase: 'off', elapsed: 0 };
const CANCELLED = Symbol('preview-cancelled');

export function createPreviewController(deps: PreviewDeps): PreviewController {
  const timer = deps.timer ?? systemTimer;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { timer.after(ms, r); }));

  let gen = 0;
  let input: PreviewInput | null = null;
  let kept = false;
  let cleaned = false;
  let listOk = false;
  let wasListed = false;
  let addedByPreview = false;
  let addedHash: string | undefined;
  let torrentId: number | null = null;
  let player: PreviewPlayer | null = null;
  let tickCancel: (() => void) | null = null;
  let stopCancel: (() => void) | null = null;
  let seeked = false;
  // Adds still on their way to TorBox, by result id. A preview stopped in that moment has no torrent
  // id to delete yet, so the add's own continuation removes it, unless Add was tapped meanwhile.
  const inflight = new Map<PreviewInput['id'], { kept: boolean }>();
  const removeStray = (id: number, title: string) => {
    deps.deleteTorrent(id).catch(() => {
      deps.toast(`Couldn’t remove the preview of “${title}”. Remove it at torbox.app.`, 'err');
    });
  };

  const emit = (s: PreviewState) => { try { deps.onState(s); } catch { /* the screen is gone */ } };

  const releasePlayer = () => {
    const p = player;
    player = null;
    if (!p) return;
    try { p.pause(); p.remove(); } catch { /* already released */ }
  };

  const cancelTimers = () => {
    tickCancel?.(); tickCancel = null;
    stopCancel?.(); stopCancel = null;
  };

  // At most one delete: a second cleanup (Stop then unmount, say) must not delete the torrent twice.
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (!shouldDeleteOnCleanup({ listOk, wasListed, torrentId, kept })) return;
    const title = input?.title ?? 'this book';
    deps.deleteTorrent(torrentId!).catch(() => {
      deps.toast(`Couldn’t remove the preview of “${title}”. Remove it at torbox.app.`, 'err');
    });
  };

  const stop = () => {
    gen++;
    cancelTimers();
    releasePlayer();
    cleanup();
    input = null;
    emit(OFF);
  };

  const onStatus = (s: PreviewStatus) => {
    if (s.error) { deps.toast('The preview stream failed.', 'err'); stop(); return; }
    if (!seeked && s.duration > 0) {
      seeked = true;
      const off = startOffset(s.duration);
      if (off > 0) player?.seekTo(off);
    }
    if (s.didJustFinish) stop();
  };

  const beginPlaying = (url: string) => {
    player = deps.createPlayer(url, onStatus);
    seeked = false;
    const started = timer.now();
    player.play();
    tickCancel = timer.every(1000, () => emit({ phase: 'playing', elapsed: Math.floor((timer.now() - started) / 1000) }));
    stopCancel = timer.after(PREVIEW_MAX_MS, stop);
    emit({ phase: 'playing', elapsed: 0 });
  };

  const run = async (my: number, r: PreviewInput) => {
    const hash = (r.hash ?? hashFromMagnet(r.magnet) ?? undefined)?.toLowerCase();
    const matches = (t: TBTorrent) => (hash ? (t.hash ?? '').toLowerCase() === hash : torrentId != null && t.id === torrentId);
    const ready = (t: TBTorrent | undefined) => !!t && isReady(t) && chapterList(t).length > 0;

    try {
      // Step 2: read the account once. A failure adds and deletes nothing at all.
      let list: TBTorrent[];
      try { list = await deps.listTorrents(); }
      catch (e: any) {
        if (my !== gen) return;
        deps.toast(e?.message ?? 'Could not reach TorBox.', 'err');
        stop();
        return;
      }
      if (my !== gen) return;
      listOk = true;
      const existing = list.find(matches);
      wasListed = !!existing;

      // Step 3: add the torrent only when the account did not already have it.
      let target = existing;
      if (!existing) {
        const mine = { kept: false };
        inflight.set(r.id, mine);
        let res: Awaited<ReturnType<PreviewDeps['addMagnet']>>;
        try { res = await deps.addMagnet(r.magnet, r.title); }
        finally { if (inflight.get(r.id) === mine) inflight.delete(r.id); }
        if (my !== gen) {
          // Stopped while the add was in flight: the torrent is this preview's, and nobody kept it.
          if (res.torrent_id && !mine.kept) removeStray(res.torrent_id, r.title);
          return;
        }
        if (res.queued_id && !res.torrent_id) {
          deps.toast(`“${r.title}” is queued on TorBox: your download slots are full, so the preview can’t start.`);
          stop(); // held in TorBox's queue, not as a torrent, so there is nothing to delete
          return;
        }
        if (res.torrent_id) { torrentId = res.torrent_id; addedByPreview = true; }
        addedHash = res.hash ?? hash;
        target = undefined; // it is not in the list we read; the poll waits for it
      }

      // Step 4: wait, then play the first audio file.
      const started = timer.now();
      while (!ready(target)) {
        if (my !== gen) throw CANCELLED;
        if (pollExpired(started, timer.now())) throw new Error('TorBox didn’t have the preview ready in time.');
        await sleep(PREVIEW_POLL_MS);
        if (my !== gen) throw CANCELLED;
        target = (await deps.listTorrents()).find(matches);
      }
      if (my !== gen) return;
      const file = previewFile(target!);
      if (!file) throw new Error('That torrent has no audio file to preview.');
      const url = await deps.getStreamUrl(target!.id, file.id);
      if (my !== gen) return;
      beginPlaying(url);
    } catch (e: any) {
      // A cancelled run belongs to a preview that was already stopped: no toast, no second cleanup.
      if (e === CANCELLED || my !== gen) return;
      deps.toast(e?.message ?? 'The preview failed.', 'err');
      stop();
    }
  };

  return {
    start(r) {
      if (input) stop(); // starting another preview ends the first one (and deletes its torrent if unkept)
      input = r;
      gen++;
      kept = false; cleaned = false; listOk = false; wasListed = false;
      addedByPreview = false; addedHash = undefined; torrentId = null;
      emit({ phase: 'preparing', elapsed: 0 });
      return run(gen, r);
    },
    keep(id) {
      const pending = inflight.get(id);
      if (pending) pending.kept = true; // Add was tapped for a preview whose add has not come back yet
      if (!input || input.id !== id) return null;
      kept = true;
      const handoff = addedByPreview ? { hash: addedHash, torrentId: torrentId ?? undefined } : null;
      stop();
      return handoff;
    },
    stop,
  };
}
