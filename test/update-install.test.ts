import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Release } from '../src/update-check';
import {
  apkProblem, cacheFileName, createInstallController, installedApkNames, installerOutcome, isZip, progressFraction, progressLabel,
  type InstallDeps, type InstallDownload, type InstallState,
} from '../src/update-install';

const release = (over: Partial<Release> = {}): Release => ({
  version: '1.4.0',
  notes: '',
  pageUrl: 'https://github.com/KeyTen4T/Earmark/releases/tag/v1.4.0',
  apkUrl: 'https://github.com/KeyTen4T/Earmark/releases/download/v1.4.0/Earmark-1.4.0.apk',
  apkSize: 1000,
  ...over,
});

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const NOT_ZIP = new Uint8Array([0x3c, 0x21, 0x44, 0x4f]); // "<!DO"

// ---- pure decisions ----

test('update-install: progress fraction and label', () => {
  assert.equal(progressFraction(0, 100), 0);
  assert.equal(progressFraction(42, 100), 0.42);
  assert.equal(progressFraction(150, 100), 1);
  assert.equal(progressFraction(50, 0), 0); // unknown total
  assert.equal(progressFraction(50, -1), 0);
  assert.equal(progressFraction(NaN, 100), 0);
  assert.equal(progressLabel(42, 100), '42%');
  assert.equal(progressLabel(1, 3), '33%');
  assert.equal(progressLabel(100, 100), '100%');
  assert.equal(progressLabel(0, 0), '');
});

test('update-install: the cache file name is derived from the version and sanitised', () => {
  assert.equal(cacheFileName('1.4.0'), 'Earmark-1.4.0.apk');
  assert.equal(cacheFileName(' v1.4.0 '), 'Earmark-v1.4.0.apk');
  assert.equal(cacheFileName('1.4.0/../../x'), 'Earmark-1.4.0_.._.._x.apk');
  assert.equal(cacheFileName(''), 'Earmark-update.apk');
});

test('update-install: isZip spots the ZIP local-file header', () => {
  assert.equal(isZip(ZIP), true);
  assert.equal(isZip(NOT_ZIP), false);
  assert.equal(isZip(new Uint8Array([0x50, 0x4b])), false);
  assert.equal(isZip(null), false);
  assert.equal(isZip(undefined), false);
});

test('update-install: apkProblem reports empty, wrong-sized and non-ZIP files', () => {
  assert.equal(apkProblem({ expectedSize: 100, actualSize: 100, head: ZIP }), null);
  assert.equal(apkProblem({ actualSize: 123, head: ZIP }), null); // no size in the release: nothing to compare
  assert.match(apkProblem({ actualSize: 0 })!, /missing or empty/);
  assert.match(apkProblem({})!, /missing or empty/);
  assert.match(apkProblem({ expectedSize: 100, actualSize: 90, head: ZIP })!, /90 bytes/);
  assert.match(apkProblem({ actualSize: 100, head: NOT_ZIP })!, /not an Android app package/);
  assert.match(apkProblem({ actualSize: 100, head: null })!, /could not be read/);
});

test('update-install: installerOutcome tells a dismissal from a failure', () => {
  const cancelled = installerOutcome(0);
  assert.equal(cancelled.kind, 'cancelled');
  assert.match(cancelled.message, /not installed/);
  assert.match(cancelled.message, /dismissed/);
  const failed = installerOutcome(-1);
  assert.equal(failed.kind, 'failed');
  assert.match(failed.message, /not yet allowed to install apps/);
});

// ---- controller ----

type Harness = ReturnType<typeof makeDeps>;

function makeDeps(over: Partial<InstallDeps> = {}) {
  const files = new Map<string, { size: number; head: Uint8Array }>();
  const state: InstallState[] = [];
  const toasts: { text: string; kind?: 'ok' | 'err' }[] = [];
  const downloads: string[] = [];
  const launches: string[] = [];
  const deleted: string[] = [];
  let resultCode = 0;
  const deps: InstallDeps = {
    listCache: () => [...files.keys()],
    deleteFile: (name) => { deleted.push(name); files.delete(name); },
    download: async (d) => {
      downloads.push(d.name);
      files.set(d.name, { size: d.expectedSize ?? 1, head: ZIP });
      d.onProgress(d.expectedSize ?? 1, d.expectedSize ?? 1);
    },
    fileSize: (name) => files.get(name)?.size ?? null,
    readHead: async (name) => files.get(name)?.head ?? null,
    contentUri: async (name) => `content://test/${name}`,
    launchInstaller: async (uri) => { launches.push(uri); return resultCode; },
    openPage: () => {},
    onState: (s) => state.push(s),
    toast: (text, kind) => toasts.push({ text, kind }),
    ...over,
  };
  return { deps, files, state, toasts, downloads, launches, deleted, setResult: (n: number) => { resultCode = n; } };
}

const phases = (h: Harness) => [...new Set(h.state.map((s) => s.phase))];
const last = (h: Harness) => h.state[h.state.length - 1];

test('update-install: the happy path downloads, verifies and launches the installer', async () => {
  const h = makeDeps();
  const c = createInstallController(h.deps);
  await c.start(release());
  // The installer returns (resultCode 0 here), so the app is still alive: the update did not go in.
  assert.deepEqual(phases(h), ['downloading', 'verifying', 'installing', 'failed']);
  assert.ok(h.state.some((s) => s.phase === 'downloading' && s.received === 1000 && s.total === 1000));
  assert.deepEqual(h.downloads, ['Earmark-1.4.0.apk']);
  assert.deepEqual(h.launches, ['content://test/Earmark-1.4.0.apk']);
  assert.match((last(h) as { message: string }).message, /not installed/);
  assert.equal(h.toasts.length, 0); // a dismissal is shown, but not as an error toast
});

test('update-install: a failure result is reported as an error toast', async () => {
  const h = makeDeps();
  h.setResult(-1);
  const c = createInstallController(h.deps);
  await c.start(release());
  assert.equal(last(h).phase, 'failed');
  assert.equal(h.toasts[0]?.kind, 'err');
});

test('update-install: a size that differs from the release fails before launching', async () => {
  const h = makeDeps({ fileSize: () => 999 });
  const c = createInstallController(h.deps);
  await c.start(release());
  assert.equal(last(h).phase, 'failed');
  assert.match((last(h) as { message: string }).message, /999 bytes/);
  assert.equal(h.launches.length, 0);
  assert.equal(h.toasts[0]?.kind, 'err');
});

test('update-install: a failed download ends in a readable failure', async () => {
  const h = makeDeps({ download: async () => { throw new Error('No network connection.'); } });
  const c = createInstallController(h.deps);
  await c.start(release());
  assert.equal(last(h).phase, 'failed');
  assert.equal((last(h) as { message: string }).message, 'No network connection.');
  assert.equal(h.toasts[0]?.kind, 'err');
});

test('update-install: a body that is not a ZIP fails verification', async () => {
  const h = makeDeps({ readHead: async () => NOT_ZIP });
  const c = createInstallController(h.deps);
  await c.start(release());
  assert.equal(last(h).phase, 'failed');
  assert.match((last(h) as { message: string }).message, /not an Android app package/);
});

test('update-install: cancel aborts the download and returns to idle', async () => {
  let seen: AbortSignal | undefined;
  const download = (d: InstallDownload) => new Promise<void>((_resolve, reject) => {
    seen = d.signal;
    d.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const h = makeDeps({ download });
  const c = createInstallController(h.deps);
  const started = c.start(release());
  await Promise.resolve();
  assert.equal(c.state().phase, 'downloading');
  c.cancel();
  await started;
  assert.equal(c.state().phase, 'idle');
  assert.equal(seen?.aborted, true);
  assert.equal(h.toasts.length, 0); // cancelling is not a failure
});

test('update-install: a second start while running does not start a second download', async () => {
  let downloads = 0;
  let resolveDownload: (() => void) | undefined;
  const h = makeDeps({ download: () => { downloads++; return new Promise<void>((r) => { resolveDownload = r; }); } });
  const c = createInstallController(h.deps);
  const first = c.start(release());
  await c.start(release()); // ignored: one is already running
  assert.equal(downloads, 1);
  resolveDownload?.();
  await first;
});

test('update-install: only APKs of versions already running are cleared at start', () => {
  assert.deepEqual(installedApkNames(['Earmark-1.3.12.apk', 'Earmark-1.3.13.apk', 'Earmark-1.4.0.apk', 'cover.jpg', 'Earmark-update.apk'], '1.3.13'),
    ['Earmark-1.3.12.apk', 'Earmark-1.3.13.apk']);
});

test('update-install: stale Earmark APKs are deleted before a download', async () => {
  const h = makeDeps();
  h.files.set('Earmark-1.3.0.apk', { size: 10, head: ZIP });
  h.files.set('notes.txt', { size: 10, head: ZIP });
  const c = createInstallController(h.deps);
  await c.start(release());
  assert.ok(h.deleted.includes('Earmark-1.3.0.apk'));
  assert.ok(!h.deleted.includes('notes.txt'));
});

test('update-install: a release without an APK opens the release page', async () => {
  let opened = '';
  const h = makeDeps({ openPage: (u) => { opened = u; } });
  const c = createInstallController(h.deps);
  await c.start(release({ apkUrl: undefined }));
  assert.equal(opened, release().pageUrl);
  assert.equal(c.state().phase, 'idle');
  assert.equal(h.downloads.length, 0);
});
