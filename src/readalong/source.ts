// Where the read-along view gets its book text: the EPUB bytes live on disk (desktop: saved by the
// Electron shell; Android: cached under Paths.document), never in the synced record. This module is
// the thin platform glue around that; the parse-and-check step is pure (`paragraphSource`) so it can
// be tested directly.
//
// Platform-only modules (react-native, expo-file-system, storage, torbox) are imported lazily inside
// the functions, so this file stays importable by the Node test runner for its pure helpers.

import { buildWordIndex, type ReadalongRecord } from './anchors';
import { parseEpub, paragraphsSha1 } from './epub';
import { readalongBridge } from './desktop';
import { largestEpub } from './scope';
import type { TBTorrent, TBFile } from '../torbox';

/** A read-along's paragraph list, plus the word -> paragraph map and whether the EPUB still matches. */
export type ParagraphSource = {
  paragraphs: string[];
  wordToPara: Int32Array;
  sha1Ok: boolean;
};

/** Session cache, keyed by audio hash + the record's paragraph hash (a rebuild invalidates it). */
const cache = new Map<string, ParagraphSource>();

/** Forgets the cached paragraph lists (used when a read-along is rebuilt/removed). */
export function clearParagraphsCache(): void {
  cache.clear();
}

/**
 * Parses EPUB bytes into the view's source, and checks that the text still matches the record's
 * `paragraphsSha1`. Pure. An empty recorded hash (older records) is treated as a match, so no
 * spurious warning is shown.
 */
export function paragraphSource(bytes: Uint8Array, expectedSha1: string): ParagraphSource {
  let paragraphs: string[];
  try {
    paragraphs = parseEpub(bytes).paragraphs;
  } catch (e) {
    throw new Error(`Couldn't read the EPUB: ${e instanceof Error ? e.message : String(e)}`);
  }
  const actual = paragraphsSha1(paragraphs);
  return {
    paragraphs,
    wordToPara: buildWordIndex(paragraphs),
    sha1Ok: !expectedSha1 || actual === expectedSha1,
  };
}

/** The TorBox torrent the record's EPUB came from, by info-hash. Pure. */
/** An EPUB small enough to read into memory on a phone. */
export function isUsableEpub(file: { name: string; size?: number }): boolean {
  return /\.epub$/i.test(file.name) && (file.size ?? 0) <= MAX_EPUB_BYTES;
}
const MAX_EPUB_BYTES = 50 * 1024 * 1024;

export function findEpubTorrent(torrents: TBTorrent[], hash: string): TBTorrent | undefined {
  const want = hash.trim().toLowerCase();
  if (!want) return undefined;
  return torrents.find((t) => t.hash?.toLowerCase() === want);
}

/** Reads the TorBox API key, with a message the read-along view can show. */
async function requireToken(): Promise<string> {
  const { getApiKey } = await import('../storage');
  const token = await getApiKey();
  if (!token) throw new Error('Add your TorBox API key in Settings to download the EPUB.');
  return token;
}

/**
 * A direct download URL for the record's EPUB file. Throws a readable message when the torrent or
 * file is no longer in the account (the old read-along's EPUB torrent may have been removed).
 */
async function epubUrl(record: ReadalongRecord): Promise<string> {
  const token = await requireToken();
  const { listTorrents, getStreamUrl } = await import('../torbox');
  const torrent = findEpubTorrent(await listTorrents(token), record.epub.hash);
  if (!torrent) throw new Error('The EPUB is no longer in your TorBox. Rebuild the read-along on the desktop.');
  const files = torrent.files ?? [];
  const file = files.find((f) => f.id === record.epub.fileId) ?? largestEpub(files);
  if (!file) throw new Error('The EPUB file is missing from TorBox. Rebuild the read-along on the desktop.');
  // Never pull anything else into memory: read-alongs saved by 1.3.0-beta.1 pointed at the
  // audiobook torrent, whose file 0 is a whole audiobook.
  if (!isUsableEpub(file)) throw new Error('This read-along points at the wrong file. Rebuild it on the desktop.');
  return getStreamUrl(token, torrent.id, file.id);
}

async function loadDesktop(audioHash: string, record: ReadalongRecord, onDownload?: () => void): Promise<Uint8Array> {
  const bridge = readalongBridge();
  if (!bridge) throw new Error('Read-along viewing is only available on the desktop app and on Android.');
  const saved = await bridge.readEpub(audioHash);
  if (saved && saved.length) return saved;
  onDownload?.();
  return bridge.fetchEpub(await epubUrl(record), audioHash);
}

async function loadAndroid(audioHash: string, record: ReadalongRecord, onDownload?: () => void): Promise<Uint8Array> {
  return downloadAndroid(await epubUrl(record), audioHash, onDownload);
}

/**
 * Downloads an EPUB's bytes to the device, reusing the phone's on-disk cache (or the desktop
 * bridge). `audioHash` names the cached file so a later reading view finds the same copy.
 */
export async function fetchEpubBytes(
  torrent: TBTorrent,
  file: TBFile,
  audioHash: string,
  onDownload?: () => void,
): Promise<Uint8Array> {
  const { getApiKey } = await import('../storage');
  const token = await getApiKey();
  if (!token) throw new Error('Add your TorBox API key in Settings to download the EPUB.');
  const { getStreamUrl } = await import('../torbox');
  const url = await getStreamUrl(token, torrent.id, file.id);

  const bridge = readalongBridge();
  if (bridge) {
    onDownload?.();
    return bridge.fetchEpub(url, audioHash);
  }
  const { Platform } = await import('react-native');
  if (Platform.OS === 'android') return downloadAndroid(url, audioHash, onDownload);
  throw new Error('Building on the server needs the Android app or the desktop app.');
}

/** Downloads `url` into the app's read-along cache and returns its bytes. Throws a readable error. */
async function downloadAndroid(url: string, audioHash: string, onDownload?: () => void): Promise<Uint8Array> {
  const { Directory, File, Paths } = await import('expo-file-system');
  const dir = new Directory(Paths.document, 'readalong');
  const file = new File(dir, `${audioHash}.epub`);
  // 1.3.0-beta.1 could save a whole audiobook here; drop anything too big to be the EPUB.
  if (file.exists && (file.size ?? 0) > MAX_EPUB_BYTES) file.delete();
  if (!file.exists) {
    if (!dir.exists) dir.create({ intermediates: true });
    onDownload?.();
    const temp = new File(dir, `${audioHash}.epub.part`);
    if (temp.exists) temp.delete();
    try {
      await File.downloadFileAsync(url, temp, { idempotent: true });
      if (file.exists) file.delete();
      if ((temp.size ?? 0) > MAX_EPUB_BYTES) throw new Error('the file is too large to be the EPUB');
      await temp.move(file, { overwrite: true });
    } catch (e) {
      try { if (temp.exists) temp.delete(); } catch { /* ignore */ }
      throw new Error(`Couldn't download the EPUB: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return file.bytes();
}

/**
 * The paragraphs for `audioHash`, downloading and parsing the EPUB the first time. `onDownload` fires
 * just before a download starts, so the view can say "Downloading the EPUB…". Cached per hash for
 * the session. Throws a readable error when the EPUB can't be found or read.
 */
export async function loadParagraphs(
  audioHash: string,
  record: ReadalongRecord,
  onDownload?: () => void,
): Promise<ParagraphSource> {
  const key = `${audioHash.toLowerCase()}|${record.epub.paragraphsSha1}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { Platform } = await import('react-native');
  const bytes = Platform.OS === 'android'
    ? await loadAndroid(audioHash, record, onDownload)
    : await loadDesktop(audioHash, record, onDownload);

  const source = paragraphSource(bytes, record.epub.paragraphsSha1);
  cache.set(key, source);
  return source;
}
