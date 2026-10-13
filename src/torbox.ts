import { fetchWithTimeout } from './fetch-timeout';

const BASE = 'https://api.torbox.app/v1/api';

/** JSON API calls: plenty for TorBox's usual reply, short enough that a dead socket cannot hang. */
const CALL_TIMEOUT_MS = 20_000;

export type TBFile = { id: number; name: string; short_name?: string; size: number; mimetype?: string };
export type TBTorrent = {
  id: number;
  name: string;
  hash: string;
  size: number;
  created_at?: string;
  download_state?: string;
  download_finished: boolean;
  download_present: boolean;
  progress: number;
  download_speed?: number;
  eta?: number;
  files: TBFile[] | null;
};

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav|wma)$/i;
export const isAudio = (f: TBFile) => AUDIO_EXT.test(f.name) || !!f.mimetype?.startsWith('audio/');
export const isReady = (t: TBTorrent) => t.download_finished && t.download_present;
/** Not ready and not going to be: TorBox gave up on it or dropped it. It needs re-adding or removing. */
export const isStuck = (t: TBTorrent) => !isReady(t) && /^(expired|incomplete|failed|error)/i.test(t.download_state ?? '');

export class TorBoxError extends Error {
  /** True when TorBox itself replied with this error, as opposed to not being reachable. */
  answered = false;
}

async function call<T>(token: string, path: string, init?: RequestInit, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    }, timeoutMs);
  } catch {
    throw new TorBoxError('Could not reach TorBox. Check your connection.');
  }
  let json: any;
  try { json = await res.json(); } catch { throw new TorBoxError(`TorBox returned HTTP ${res.status}`); }
  if (!json.success) {
    if (res.status === 401 || json.error === 'AUTH_ERROR' || json.error === 'BAD_TOKEN') {
      throw new TorBoxError('Your TorBox API key was rejected.');
    }
    const err = new TorBoxError(json.detail || json.error || `TorBox error ${res.status}`);
    err.answered = true;
    throw err;
  }
  return json.data as T;
}

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|wmv|m4v|webm|mpg|mpeg|ts|iso)$/i;
const isVideo = (f: TBFile) => VIDEO_EXT.test(f.name) || !!f.mimetype?.startsWith('video/');
const AUDIO_NAME = /\b(audio ?books?|unabridged|abridged|m4b|mp3|flac|\d{2,3} ?kbps|narrat\w*|read by|librivox)\b/i;
const VIDEO_NAME = /\b(2160p|1080p|720p|480p|4k|uhd|x26[45]|h ?26[45]|hevc|xvid|blu-?ray|b[dr]rip|web-?dl|webrip|hdtv|dvdrip|remux|s\d{1,2}e\d{1,2}|season ?\d+|complete series|films?|movies?|extended|unrated|theatrical|director'?s cut)\b/i;

/**
 * Whether a TorBox item belongs in an audiobook library. The account may also hold movies and
 * shows. Goes by the file list when TorBox has one (mostly audio by size), otherwise by the name.
 */
export function looksLikeAudiobook(t: TBTorrent): boolean {
  const files = t.files ?? [];
  if (files.length) {
    const bytes = (pick: (f: TBFile) => boolean) => files.filter(pick).reduce((n, f) => n + (f.size || 0), 0);
    const audio = files.filter(isAudio);
    return audio.length > 0 && bytes(isAudio) >= bytes((f) => isVideo(f) && !isAudio(f));
  }
  if (isReady(t)) return false; // finished with no files listed: nothing to play
  const name = t.name.replace(/[._]+/g, ' ');
  return AUDIO_NAME.test(name) || !VIDEO_NAME.test(name);
}

/** The account's torrents that look like audiobooks, including ones still downloading or expired. */
export async function listBooks(token: string): Promise<TBTorrent[]> {
  const data = await call<TBTorrent[] | null>(token, '/torrents/mylist?bypass_cache=true');
  return (data ?? []).filter(looksLikeAudiobook);
}

/**
 * Every torrent in the account, with no audiobook filter. The read-along builder needs this: an
 * EPUB-only torrent is not an audiobook, so `listBooks` would hide it once it finishes downloading.
 */
export async function listTorrents(token: string): Promise<TBTorrent[]> {
  const data = await call<TBTorrent[] | null>(token, '/torrents/mylist?bypass_cache=true');
  return data ?? [];
}

export async function verifyKey(token: string) {
  await call(token, '/user/me');
}

export async function addMagnet(token: string, magnet: string, name?: string) {
  const body = new FormData();
  body.append('magnet', magnet);
  if (name) body.append('name', name);
  // queued_id instead of torrent_id: the account's download slots are full, so TorBox is holding it in its queue.
  return call<{ torrent_id?: number; queued_id?: number; hash: string; name?: string }>(token, '/torrents/createtorrent', { method: 'POST', body });
}

/**
 * Asks TorBox to look the torrent up in the swarm. Null when TorBox answered but found nothing at
 * all (an error reply from TorBox counts as that, as it always has); throws (TorBoxError) when TorBox
 * could not be reached or timed out, so a failed check is never read as "no seeders".
 * Slow: TorBox takes 10-40s to answer whatever timeout it is given.
 */
export async function torrentHealth(token: string, magnet: string): Promise<{ seeds: number; peers: number } | null> {
  const body = new FormData();
  body.append('magnet', magnet);
  body.append('timeout', '10');
  try {
    // TorBox itself takes 10-40s to answer this one, so it gets a longer limit than the other calls.
    const d = await call<{ seeds?: number; peers?: number } | null>(token, '/torrents/torrentinfo', { method: 'POST', body }, 50_000);
    return d ? { seeds: Number(d.seeds) || 0, peers: Number(d.peers) || 0 } : null;
  } catch (e) {
    if (e instanceof TorBoxError && e.answered) return null;
    throw e;
  }
}

export async function deleteTorrent(token: string, torrentId: number) {
  const send = () => call(token, '/torrents/controltorrent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ torrent_id: torrentId, operation: 'delete' }),
  });
  try { await send(); return; } catch (e: any) {
    // DATABASE_ERROR is a fault on TorBox's side and is often momentary: wait, then try once more.
    if (!/DATABASE_ERROR/.test(e?.message ?? '')) throw e;
  }
  await new Promise((r) => setTimeout(r, 2000));
  try { await send(); } catch (e: any) {
    // TorBox can report an error for a delete that did go through, so check before failing.
    const left = await call<TBTorrent[] | null>(token, '/torrents/mylist?bypass_cache=true').catch(() => null);
    if (left && !left.some((t) => t.id === torrentId)) return;
    throw new TorBoxError(/DATABASE_ERROR/.test(e?.message ?? '')
      ? 'TorBox had a server error (DATABASE_ERROR). Try again in a minute, or remove it at torbox.app.'
      : e?.message ?? 'TorBox error');
  }
}

/** Set of hashes TorBox already has cached (instant to add). Best effort: returns empty set on failure. */
export async function checkCached(token: string, hashes: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const uniq = [...new Set(hashes.filter(Boolean).map((h) => h.toLowerCase()))];
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    try {
      const data = await call<any>(token, `/torrents/checkcached?hash=${chunk.join(',')}&format=list&list_files=false`);
      if (Array.isArray(data)) data.forEach((d) => d?.hash && out.add(String(d.hash).toLowerCase()));
      else if (data && typeof data === 'object') Object.keys(data).forEach((h) => out.add(h.toLowerCase()));
    } catch { /* ignore */ }
  }
  return out;
}

/** Temporary direct URL for one file. Request right before playing; links expire. */
export async function getStreamUrl(token: string, torrentId: number, fileId: number): Promise<string> {
  const q = `?token=${encodeURIComponent(token)}&torrent_id=${torrentId}&file_id=${fileId}&redirect=false`;
  return call<string>(token, `/torrents/requestdl${q}`);
}

/** Audio files in natural order ("Chapter 2" before "Chapter 10"). */
export function chapterList(t: TBTorrent): TBFile[] {
  return (t.files ?? [])
    .filter(isAudio)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

export function chapterTitle(f: TBFile) {
  const base = (f.short_name ?? f.name.split('/').pop() ?? f.name).replace(AUDIO_EXT, '');
  return base.replace(/[_]+/g, ' ').trim();
}
