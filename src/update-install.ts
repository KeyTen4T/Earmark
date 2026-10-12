// The pure half of the in-app Android update: the installer's state, its progress maths, the cache
// file name, the APK sanity check and the decision made when the installer activity returns. The
// platform calls (download, file system, IntentLauncher) are injected, so the controller's sequence
// is unit-tested with fakes (test/update-install.test.ts). Deliberately free of React Native and
// Expo imports.
import { compareVersions, type Release } from './update-check';

/** Where the Android updater is: fetching the APK, checking it, or handing it to the installer. */
export type InstallState =
  | { phase: 'idle' }
  | { phase: 'downloading'; received: number; total: number }
  | { phase: 'verifying' }
  | { phase: 'installing' }
  | { phase: 'failed'; message: string };

export const IDLE: InstallState = { phase: 'idle' };

/** 0..1 of a download; 0 while the total is unknown or nonsense. */
export function progressFraction(received: number, total: number): number {
  if (!Number.isFinite(received) || !Number.isFinite(total) || total <= 0 || received <= 0) return 0;
  return Math.min(1, received / total);
}

/** The percent shown beside “Downloading…”, or '' while the total is unknown. */
export function progressLabel(received: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '';
  return `${Math.floor(progressFraction(received, total) * 100)}%`;
}

/** The cache file an update downloads to: `Earmark-<version>.apk`, with anything odd folded to `_`. */
export function cacheFileName(version: string): string {
  const safe = String(version ?? '').trim().replace(/[^0-9A-Za-z._-]+/g, '_').replace(/^\.+/, '');
  return `Earmark-${safe || 'update'}.apk`;
}

/** True when `head` starts with the ZIP local-file header `PK\x03\x04` (every APK is a ZIP). */
export function isZip(head: ArrayLike<number> | null | undefined): boolean {
  return !!head && head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/**
 * A reason not to install a downloaded APK, or null when it looks right. Covers a missing or empty
 * file, a size that differs from the release asset's (when GitHub gave one) and a body whose first
 * bytes are not a ZIP.
 */
export function apkProblem(input: {
  expectedSize?: number;
  actualSize?: number;
  head?: ArrayLike<number> | null;
}): string | null {
  const { expectedSize, actualSize, head } = input;
  if (actualSize == null || actualSize <= 0) return 'The update file is missing or empty.';
  if (expectedSize != null && expectedSize > 0 && actualSize !== expectedSize) {
    return `The update downloaded ${actualSize} bytes, but the release lists ${expectedSize}.`;
  }
  if (head == null || head.length < 4) return 'The update file could not be read.';
  if (!isZip(head)) return 'The downloaded file is not an Android app package.';
  return null;
}

export const RESULT_CANCELED = 0;

export type InstallerOutcome = { kind: 'cancelled' | 'failed'; message: string };

/**
 * What the installer activity's result means while Earmark is still running: a successful install
 * replaces the package and kills this process, so reaching here always means the update did not go
 * in. RESULT_CANCELED is the user dismissing the prompt; anything else is a failure, most often that
 * Earmark is not yet allowed to install apps.
 */
export function installerOutcome(resultCode: number): InstallerOutcome {
  const cancelled = resultCode === RESULT_CANCELED;
  return {
    kind: cancelled ? 'cancelled' : 'failed',
    message: 'The update was not installed. The install prompt may have been dismissed, or Earmark is not yet allowed to install apps.',
  };
}

// ---- The controller ----

export type InstallDownload = {
  url: string;
  /** Cache file name (not a full path). */
  name: string;
  expectedSize?: number;
  onProgress: (received: number, total: number) => void;
  signal: AbortSignal;
};

/** The platform half: reading and writing the cache, downloading, and the installer itself. */
export type InstallDeps = {
  /** Names of the files in the cache directory. */
  listCache: () => string[];
  /** Delete one cache file by name; a missing file is not an error. */
  deleteFile: (name: string) => void;
  /** Download `url` to the cache file `name`, reporting progress. Rejects with a readable Error. */
  download: (d: InstallDownload) => Promise<void>;
  /** Byte size of a cache file, or null when it is missing or unreadable. */
  fileSize: (name: string) => number | null;
  /** First `length` bytes of a cache file, or null when it cannot be read. */
  readHead: (name: string, length: number) => Promise<Uint8Array | null>;
  /** A content:// URI for a cache file that another app may read. */
  contentUri: (name: string) => Promise<string>;
  /** Start the package installer, resolving with its result code when it returns to the app. */
  launchInstaller: (contentUri: string) => Promise<number>;
  /** Fall back to the release page when there is no APK to install. */
  openPage: (pageUrl: string) => void;
  onState: (state: InstallState) => void;
  toast: (text: string, kind?: 'ok' | 'err') => void;
};

export type InstallController = {
  state: () => InstallState;
  /** Android only. Downloads and installs `release`'s APK; a second call while running is ignored. */
  start: (release: Release) => Promise<void>;
  /** Stops a download in progress and returns to idle. */
  cancel: () => void;
};

// A leftover APK from an earlier attempt (or an earlier version) only takes up space.
const STALE_APK = /^Earmark-.*\.apk$/i;
const HEAD_BYTES = 4;

/** Downloaded updates that are no newer than the running version: installed already, so safe to delete. */
export function installedApkNames(names: string[], current: string): string[] {
  return names.filter((name) => {
    const m = /^Earmark-(\d[0-9A-Za-z._-]*)\.apk$/i.exec(name);
    return !!m && compareVersions(m[1], current) <= 0;
  });
}

export function createInstallController(deps: InstallDeps): InstallController {
  let state: InstallState = IDLE;
  let running = false;
  let gen = 0;
  let current: AbortController | null = null;

  const emit = (s: InstallState) => {
    state = s;
    try { deps.onState(s); } catch { /* the screen is gone */ }
  };

  const fail = (message: string) => {
    emit({ phase: 'failed', message });
    deps.toast(message, 'err');
  };

  const clearStale = () => {
    let names: string[];
    try { names = deps.listCache(); } catch { return; }
    for (const name of names) {
      if (!STALE_APK.test(name)) continue;
      try { deps.deleteFile(name); } catch { /* ignore */ }
    }
  };

  const run = async (my: number, release: Release) => {
    const url = release.apkUrl;
    if (!url) { deps.openPage(release.pageUrl); return; }
    const name = cacheFileName(release.version);
    clearStale();
    const ctl = new AbortController();
    current = ctl;
    emit({ phase: 'downloading', received: 0, total: release.apkSize ?? 0 });
    try {
      await deps.download({
        url, name, expectedSize: release.apkSize, signal: ctl.signal,
        onProgress: (received, total) => {
          if (my !== gen) return;
          emit({ phase: 'downloading', received, total: total > 0 ? total : release.apkSize ?? 0 });
        },
      });
      if (my !== gen) return;

      emit({ phase: 'verifying' });
      const actualSize = deps.fileSize(name) ?? undefined;
      const head = await deps.readHead(name, HEAD_BYTES);
      if (my !== gen) return;
      const problem = apkProblem({ expectedSize: release.apkSize, actualSize, head });
      if (problem) { try { deps.deleteFile(name); } catch { /* ignore */ } fail(problem); return; }

      const uri = await deps.contentUri(name);
      if (my !== gen) return;
      emit({ phase: 'installing' });
      const resultCode = await deps.launchInstaller(uri);
      if (my !== gen) return;
      // The APK stays in the cache: some installers are still reading it when they report back. It
      // goes on the next attempt, or at the next start once that version is the one running.
      // Reaching here means the install did not replace the app; say why it may have failed. A
      // dismissal is shown too, but as an informational message rather than an error toast.
      const outcome = installerOutcome(resultCode);
      if (outcome.kind === 'failed') fail(outcome.message);
      else emit({ phase: 'failed', message: outcome.message });
    } catch (e: any) {
      if (my !== gen) return; // cancelled or superseded
      fail(e?.message ?? 'The update could not be downloaded.');
    } finally {
      if (my === gen) { running = false; current = null; }
    }
  };

  return {
    state: () => state,
    async start(release) {
      if (running) return; // a second call must not start a second download
      running = true;
      await run(++gen, release);
    },
    cancel() {
      if (!running) return;
      gen++;
      running = false;
      current?.abort();
      current = null;
      emit(IDLE);
    },
  };
}
