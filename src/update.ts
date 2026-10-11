// In-app update check against the public GitHub releases of EarMark. No token is sent.
import { Linking, Platform } from 'react-native';
import app from '../app.json';
import { parseRelease, updateAvailable, type Release } from './update-check';

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

/** Android hands the APK to the browser to download; elsewhere open the release page. */
export function openUpdate(release: Release): void {
  const url = (Platform.OS === 'android' ? release.apkUrl : undefined) ?? release.pageUrl;
  if (url) void Linking.openURL(url);
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
