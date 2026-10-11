import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TBTorrent } from '../src/torbox';
import {
  canPreview, createPreviewController, magnetFor, pollExpired, previewFile, shouldDeleteOnCleanup, startOffset,
  PREVIEW_MAX_MS, PREVIEW_POLL_MS, PREVIEW_SKIP_S, PREVIEW_WAIT_MS, type PreviewDeps, type PreviewPlayer, type PreviewState, type PreviewStatus, type PreviewTimer,
} from '../src/preview';

// ---- pure decisions ----

test('preview: canPreview needs a cached result with a hash or magnet', () => {
  assert.equal(canPreview({ infoHash: 'ab' }, true), true);
  assert.equal(canPreview({ magnet: 'magnet:?xt=urn:btih:ab' }, true), true);
  assert.equal(canPreview({ infoHash: 'ab' }, false), false); // not cached: no preview
  assert.equal(canPreview({}, true), false); // nothing to add
  assert.equal(canPreview({ infoHash: 'ab' }, false), false);
});

test('preview: magnetFor uses the bare hash, or nothing without one', () => {
  assert.equal(magnetFor('AB', 'Dune'), 'magnet:?xt=urn:btih:ab&dn=Dune');
  assert.equal(magnetFor('ab', 'The Hobbit'), 'magnet:?xt=urn:btih:ab&dn=The%20Hobbit');
  assert.equal(magnetFor(undefined, 'Dune'), undefined);
});

test('preview: previewFile is the first audio file in chapter order', () => {
  const t = torrent({ files: [
    { id: 4, name: 'cover.jpg', size: 10 },
    { id: 2, name: 'Chapter 10.mp3', size: 20 },
    { id: 1, name: 'Chapter 2.mp3', size: 30 },
  ] });
  assert.equal(previewFile(t)?.id, 1);
  assert.equal(previewFile(torrent({ files: [{ id: 9, name: 'cover.jpg', size: 1 }] })), undefined);
  assert.equal(previewFile(torrent({ files: null })), undefined);
});

test('preview: startOffset skips the opening only on a long file', () => {
  assert.equal(startOffset(0), 0); // duration unknown: from the start
  assert.equal(startOffset(299), 0); // under five minutes
  assert.equal(startOffset(300), PREVIEW_SKIP_S);
  assert.equal(startOffset(3600), PREVIEW_SKIP_S);
});

test('preview: polling gives up after the wait window', () => {
  assert.equal(pollExpired(0, 0), false);
  assert.equal(pollExpired(0, 39_999), false);
  assert.equal(pollExpired(0, 40_000), true);
  assert.equal(pollExpired(0, 41_000), true);
});

test('preview: the delete rule holds on every branch', () => {
  const base = { listOk: true, wasListed: false, torrentId: 5, kept: false };
  // The one case that deletes.
  assert.equal(shouldDeleteOnCleanup(base), true);
  // Hash already in the account: played from as it is, never deleted.
  assert.equal(shouldDeleteOnCleanup({ ...base, wasListed: true }), false);
  // The step-2 fetch failed: nothing added, nothing deleted.
  assert.equal(shouldDeleteOnCleanup({ ...base, listOk: false, torrentId: null }), false);
  // Queued: no torrent_id of ours, so nothing to delete.
  assert.equal(shouldDeleteOnCleanup({ ...base, torrentId: null }), false);
  // The user kept it.
  assert.equal(shouldDeleteOnCleanup({ ...base, kept: true }), false);
  // A torrent that was already there is never deleted even without a keep.
  assert.equal(shouldDeleteOnCleanup({ ...base, wasListed: true, kept: false }), false);
});

// ---- controller ----

const torrent = (over: Partial<TBTorrent> = {}): TBTorrent => ({
  id: 1, name: 'Dune', hash: 'abc', size: 0, download_finished: true, download_present: true, progress: 1,
  files: [{ id: 1, name: '01.mp3', size: 1000 }],
  ...over,
});

const input = { id: 'r1', hash: 'abc', magnet: 'magnet:?xt=urn:btih:abc', title: 'Dune', narrator: 'Scott Brick' };

function makePlayer(onStatus: (s: PreviewStatus) => void) {
  const p = {
    played: 0, removed: 0, seeks: [] as number[],
    play() { p.played++; }, pause() {}, remove() { p.removed++; }, seekTo(s: number) { p.seeks.push(s); },
  };
  return { player: p as unknown as PreviewPlayer, status: onStatus, raw: p };
}

function harness(opts: {
  /** What the account list returns. */
  account?: TBTorrent[];
  /** Fail the very first listTorrents call (step 2). */
  listFails?: boolean;
  /** The torrent that shows up on the poll, once `afterPolls` fetches have happened. */
  added?: TBTorrent;
  afterPolls?: number;
  addResult?: { torrent_id?: number; queued_id?: number; hash: string };
  urlFails?: boolean;
  deleteFails?: boolean;
} = {}) {
  let t = 0;
  const jobs: { at: number; fn: () => void }[] = [];
  const intervals: { fn: () => void }[] = [];
  const timer: PreviewTimer = {
    now: () => t,
    after: (ms, fn) => { const j = { at: t + ms, fn }; jobs.push(j); return () => { const i = jobs.indexOf(j); if (i >= 0) jobs.splice(i, 1); }; },
    every: (_ms, fn) => { const j = { fn }; intervals.push(j); return () => { const i = intervals.indexOf(j); if (i >= 0) intervals.splice(i, 1); }; },
  };
  const counts = { list: 0, add: 0, del: 0, url: 0 };
  const deleted: number[] = [];
  const toasts: string[] = [];
  const states: PreviewState[] = [];
  const players: ReturnType<typeof makePlayer>[] = [];

  const deps: PreviewDeps = {
    listTorrents: async () => {
      counts.list++;
      if (opts.listFails && counts.list === 1) throw new Error('TorBox is down');
      // Step 2 returns the account as it was; only later polls may reveal the added torrent.
      const isStep2 = counts.list === 1;
      const pollN = counts.list - 2;
      if (opts.added && !isStep2 && pollN >= (opts.afterPolls ?? 0)) return [opts.added];
      return opts.account ?? [];
    },
    addMagnet: async () => { counts.add++; return opts.addResult ?? { torrent_id: 7, hash: 'abc' }; },
    getStreamUrl: async () => { counts.url++; if (opts.urlFails) throw new Error('stream failed'); return 'http://stream/01.mp3'; },
    deleteTorrent: async (id) => { counts.del++; deleted.push(id); if (opts.deleteFails) throw new Error('delete failed'); },
    createPlayer: (_uri, onStatus) => { const p = makePlayer(onStatus); players.push(p); return p.player; },
    toast: (text) => { toasts.push(text); },
    onState: (s) => { states.push(s); },
    timer,
    sleep: async (ms) => { t += ms; },
  };
  const controller = createPreviewController(deps);
  return {
    controller, counts, deleted, toasts, states, players,
    advance: (ms: number) => { t += ms; },
    fireDue: () => { [...jobs].filter((j) => j.at <= t).forEach((j) => j.fn()); },
    tick: () => { intervals.forEach((i) => i.fn()); },
  };
}

test('preview: a torrent already in the account is played from as it is and never deleted', async () => {
  const h = harness({ account: [torrent()] });
  await h.controller.start(input);
  assert.equal(h.counts.add, 0); // already there: no add
  assert.equal(h.counts.url, 1);
  assert.equal(h.players.length, 1);
  h.controller.stop();
  h.controller.stop();
  assert.equal(h.counts.del, 0);
  assert.equal(h.players[0].raw.removed, 1);
});

test('preview: a failed account fetch adds nothing and deletes nothing', async () => {
  const h = harness({ listFails: true });
  await h.controller.start(input);
  assert.equal(h.counts.add, 0);
  assert.equal(h.counts.del, 0);
  assert.equal(h.players.length, 0);
  assert.ok(h.toasts.length >= 1);
});

test('preview: a queued add is left in the queue, never deleted', async () => {
  const h = harness({ addResult: { queued_id: 33, hash: 'abc' } });
  await h.controller.start(input);
  assert.equal(h.counts.add, 1);
  assert.equal(h.counts.del, 0);
  assert.equal(h.players.length, 0);
  assert.match(h.toasts.join(' '), /queued|slots are full/i);
});

test('preview: Add keeps the torrent the preview added, and it is not deleted', async () => {
  const h = harness({ added: torrent(), addResult: { torrent_id: 7, hash: 'abc' } });
  await h.controller.start(input);
  assert.equal(h.counts.add, 1);
  assert.equal(h.players.length, 1);
  const handoff = h.controller.keep(input.id);
  assert.deepEqual(handoff, { hash: 'abc', torrentId: 7 });
  assert.equal(h.counts.del, 0);
});

test('preview: keep for another row does nothing', async () => {
  const h = harness({ added: torrent(), addResult: { torrent_id: 7, hash: 'abc' } });
  await h.controller.start(input);
  assert.equal(h.controller.keep('someone-else'), null);
  assert.equal(h.counts.del, 0); // still running, not cleaned up
  h.controller.stop();
  assert.equal(h.counts.del, 1); // now it deletes because it was never kept
});

test('preview: an unkept preview deletes exactly once however often cleanup runs', async () => {
  const h = harness({ added: torrent(), addResult: { torrent_id: 7, hash: 'abc' } });
  await h.controller.start(input);
  h.controller.stop();
  h.controller.stop();
  h.controller.stop();
  assert.equal(h.counts.del, 1);
  assert.deepEqual(h.deleted, [7]);
});

test('preview: the 75 second limit stops and deletes an unkept preview', async () => {
  const h = harness({ added: torrent(), addResult: { torrent_id: 7, hash: 'abc' } });
  await h.controller.start(input);
  h.advance(PREVIEW_MAX_MS);
  h.fireDue();
  assert.equal(h.counts.del, 1);
  assert.equal(h.players[0].raw.removed, 1);
});

test('preview: timing out while waiting deletes the torrent it added', async () => {
  // No `added`, so the poll never sees it ready: 40s of waiting, then a timeout.
  const h = harness({ added: undefined, addResult: { torrent_id: 7, hash: 'abc' } });
  await h.controller.start(input);
  assert.equal(h.counts.add, 1);
  assert.equal(h.counts.del, 1);
  assert.equal(h.counts.list >= 1 + PREVIEW_WAIT_MS / PREVIEW_POLL_MS, true);
});

test('preview: a failed stream link cleans up and deletes the torrent it added', async () => {
  const h = harness({ added: torrent(), addResult: { torrent_id: 7, hash: 'abc' }, urlFails: true });
  await h.controller.start(input);
  assert.equal(h.counts.add, 1);
  assert.equal(h.counts.del, 1);
  assert.ok(h.toasts.length >= 1);
});

test('preview: a failed delete tells the user which book to remove by hand', async () => {
  const h = harness({ added: torrent(), addResult: { torrent_id: 7, hash: 'abc' }, deleteFails: true });
  await h.controller.start(input);
  h.controller.stop();
  await new Promise((r) => setTimeout(r, 0)); // let the rejected delete's catch run
  assert.equal(h.counts.del, 1);
  assert.match(h.toasts.join(' '), /Dune/);
});

test('preview: a long file is seeked in, a short one plays from the start', async () => {
  const long = harness({ account: [torrent()] });
  await long.controller.start(input);
  long.players[0].status({ duration: 3600, position: 0, didJustFinish: false, error: null });
  assert.deepEqual(long.players[0].raw.seeks, [45]);
  long.controller.stop();

  const short = harness({ account: [torrent()] });
  await short.controller.start(input);
  short.players[0].status({ duration: 120, position: 0, didJustFinish: false, error: null });
  assert.deepEqual(short.players[0].raw.seeks, []);
  short.controller.stop();
});

// A preview stopped (or kept) while its add is still on the way to TorBox.
function midAdd(during: (c: ReturnType<typeof createPreviewController>) => void) {
  const deleted: number[] = [];
  let adds = 0;
  const c: ReturnType<typeof createPreviewController> = createPreviewController({
    listTorrents: async () => [],
    addMagnet: async () => { adds++; during(c); return { torrent_id: 7, hash: 'abc' }; },
    getStreamUrl: async () => 'http://stream/01.mp3',
    deleteTorrent: async (id) => { deleted.push(id); },
    createPlayer: (_uri, onStatus) => makePlayer(onStatus).player,
    toast: () => {},
    onState: () => {},
    sleep: async () => {},
  });
  return { c, deleted, adds: () => adds };
}

test('preview: stopped while the add is in flight, the torrent it added is still removed', async () => {
  const h = midAdd((c) => c.stop());
  await h.c.start(input);
  assert.equal(h.adds(), 1);
  assert.deepEqual(h.deleted, [7]);
  h.c.stop();
  assert.deepEqual(h.deleted, [7]); // and only once
});

test('preview: Add tapped while the add is in flight keeps the torrent', async () => {
  const h = midAdd((c) => { c.keep(input.id); });
  await h.c.start(input);
  assert.deepEqual(h.deleted, []);
});

test('preview: stopped and then Add tapped, both before the add comes back, keeps the torrent', async () => {
  const h = midAdd((c) => { c.stop(); c.keep(input.id); });
  await h.c.start(input);
  assert.deepEqual(h.deleted, []);
});
