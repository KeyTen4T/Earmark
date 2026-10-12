// In-app update check against the public GitHub releases of EarMark. No token is sent. On Android
// the update is downloaded in-app and handed to the system package installer; elsewhere the release
// page opens in the browser.
import { Linking, Platform } from 'react-native';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import app from '../app.json';
import { parseRelease, updateAvailable, type Release } from './update-check';
import { createInstallController, installedApkNames, type InstallDownload, type InstallState } from './update-install';
import { toast } from './components/ui';

const API = 'https://api.github.com/repos/KeyTen4T/Earmark/releases/latest';

/** The version the Settings footer shows, taken from the same app.json source. */
export const currentVersion = (): string => app.expo.version;

export async function checkForUpdate(): Promise<{ release: Release; newer: boolean }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal })
      .catch(() => { throw new Error('Couldn’t reach GitHub to check for updates.'); });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} while checking for updates.`);
    const json = await res.json().catch(() => { throw new Error('GitHub sent an unreadable update response.'); });
    const release = parseRelease(json);
    if (!release) throw new Error('The latest GitHub release is not a usable version.');
    return { release, newer: updateAvailable(currentVersion(), release) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- The Android in-app installer ----

// The APK is downloaded into the cache directory. expo-file-system's FileProvider covers
// <cache-path path="." />, so the file can be shared as a content:// URI with read permission.
const INSTALL_PACKAGE = 'android.intent.action.INSTALL_PACKAGE';
const INSTALL_MIME = 'application/vnd.android.package-archive';
const FLAG_GRANT_READ_URI_PERMISSION = 1;
const installerArgs = (uri: string) => ({
  data: uri,
  type: INSTALL_MIME,
  flags: FLAG_GRANT_READ_URI_PERMISSION,
  extra: {
    'android.intent.extra.RETURN_RESULT': true,
    'android.intent.extra.NOT_UNKNOWN_SOURCE': false,
  },
});

function cacheFile(name: string): File {
  return new File(Paths.cache, name);
}

async function downloadApk({ url, name, onProgress, signal }: InstallDownload): Promise<void> {
  const dest = cacheFile(name);
  if (dest.exists) dest.delete(); // a leftover from an interrupted attempt would block the download
  const task = File.createDownloadTask(url, dest, {
    onProgress: ({ bytesWritten, totalBytes }) => onProgress(bytesWritten, totalBytes),
    signal,
  });
  const file = await task.downloadAsync();
  if (!file) throw new Error('The update download was interrupted.');
}

function apkSizeOnDisk(name: string): number | null {
  try { const f = cacheFile(name); return f.exists ? f.size : null; } catch { return null; }
}

async function readApkHead(name: string, length: number): Promise<Uint8Array | null> {
  try {
    const f = cacheFile(name);
    if (!f.exists) return null;
    const handle = f.open(FileMode.ReadOnly);
    try { return handle.readBytes(length); } finally { handle.close(); }
  } catch { return null; }
}

async function apkContentUri(name: string): Promise<string> {
  return cacheFile(name).contentUri;
}

/** Hands the content URI to the system installer; if there is no INSTALL_PACKAGE handler (some TVs), VIEW still reaches it. */
async function launchInstaller(uri: string): Promise<number> {
  try {
    const res = await IntentLauncher.startActivityAsync(INSTALL_PACKAGE, installerArgs(uri));
    return res.resultCode;
  } catch {
    const res = await IntentLauncher.startActivityAsync('android.intent.action.VIEW', installerArgs(uri));
    return res.resultCode;
  }
}

// One installer for the whole app: Settings and the startup prompt both drive this.
let installState: InstallState = { phase: 'idle' };
const installListeners = new Set<(s: InstallState) => void>();
const notifyInstall = () => { for (const l of installListeners) l(installState); };

export const getInstallState = (): InstallState => installState;

export function subscribeInstall(fn: (s: InstallState) => void): () => void {
  installListeners.add(fn);
  fn(installState);
  return () => { installListeners.delete(fn); };
}

const installer = createInstallController({
  listCache: () => {
    try { return new Directory(Paths.cache).list().map((e) => e.name); } catch { return []; }
  },
  deleteFile: (name) => { try { const f = cacheFile(name); if (f.exists) f.delete(); } catch { /* ignore */ } },
  download: downloadApk,
  fileSize: apkSizeOnDisk,
  readHead: readApkHead,
  contentUri: apkContentUri,
  launchInstaller,
  openPage: (url) => { void Linking.openURL(url); },
  onState: (s) => { installState = s; notifyInstall(); },
  toast: (text, kind) => toast(text, kind),
});

/** At start: drop the APK of an update that has since been installed, so it does not sit in the cache. */
export function clearInstalledUpdates(): void {
  if (Platform.OS !== 'android') return;
  try {
    const names = new Directory(Paths.cache).list().map((e) => e.name);
    for (const name of installedApkNames(names, currentVersion())) cacheFile(name).delete();
  } catch { /* nothing to clear */ }
}

/** Stops a download in progress (the cache file is cleaned up on the next attempt). */
export function cancelUpdate(): void {
  installer.cancel();
}

/**
 * Where an update goes from here. Non-Android (or a release with no APK) opens the release page as
 * before. On Android this starts the in-app download+installer and returns true when a new download
 * began; false when the page opened instead or one was already running.
 */
export function startUpdate(release: Release): boolean {
  if (Platform.OS !== 'android' || !release.apkUrl) {
    void Linking.openURL(release.pageUrl);
    return false;
  }
  const phase = installState.phase;
  if (phase === 'downloading' || phase === 'verifying' || phase === 'installing') return false;
  void installer.start(release);
  return true;
}

/**
 * The release notes for one version, fetched by tag (`v<version>`) with the same unauthenticated
 * headers and timeout as the update check. Returns null on any failure, so an offline start leaves
 * the stored version untouched and tries again next time.
 */
export async function fetchReleaseNotes(version: string): Promise<Release | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(`https://api.github.com/repos/KeyTen4T/Earmark/releases/tags/v${version}`,
      { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    return parseRelease(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The newer release found this session, so Settings can show it without checking again.
let known: Release | null = null;
const listeners = new Set<() => void>();
export const knownUpdate = (): Release | null => known;
export function setKnownUpdate(r: Release | null): void {
  known = r;
  for (const l of listeners) l();
}
export function subscribeUpdate(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
