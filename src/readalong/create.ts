// The read-along creation flow, as plain async functions the sheet calls:
//   findEpubCandidates -> (confirm) -> ensureEpubInTorbox -> buildReadalong
// `runReadalong` wires the first two and the build together and keeps job.ts updated.
//
// This module talks to storage/TorBox so it is not imported by the Node tests; its pure pieces
// (candidate search/ranking, scope, job state) live in ebookSearch.ts, scope.ts and job.ts.

import {
  searchEbooks, looksLikeEpub, rankCandidates,
  type EbookCandidate, type EbookResult,
} from './ebookSearch';
import {
  listTorrents, addMagnet, checkCached, getStreamUrl, isReady,
  type TBTorrent, type TBFile,
} from '../torbox';
import { parseEpub, paragraphsSha1 } from './epub';
import { fromAnchorsJson, type ReadalongRecord } from './anchors';
import { readalongBridge, type ReadalongAnchorsJson } from './desktop';
import { cleanName, largestEpub } from './scope';
import { prettyName } from '../theme';
import { getApiKey, loadEbookSearchUrl, saveReadalong, loadPendingJobs, savePendingJobs, type BookMeta } from '../storage';
import { fetchEpubBytes } from './source';
import { submitJob } from './server';
import { addPending } from './pending';
import * as job from './job';

const EPUB_POLL_MS = 3_000;
const EPUB_WAIT_MS = 3 * 60 * 1000;
/** Fewer blocks than this and the tool has too little text to align reliably. */
export const MIN_PARAGRAPHS = 20;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e ?? 'Something went wrong'));

// Each run takes a number; cancelling (or starting another run) moves it on. The steps before the
// build itself (waiting for TorBox, downloading and reading the EPUB) have nothing to kill, so they
// check between steps and stop there instead of carrying on and writing over the cancelled state.
let currentRun = 0;
const stopIfCancelled = (run: number) => { if (run !== currentRun) throw new Error('cancelled'); };

async function requireKey(): Promise<string> {
  const token = await getApiKey();
  if (!token) throw new Error('Add your TorBox API key in Settings first.');
  return token;
}

/** The EPUB search address from Settings; the search can't run without one. */
async function requireSearchUrl(): Promise<string> {
  const url = (await loadEbookSearchUrl()).trim();
  if (!url) throw new Error('Add an EPUB search address in Settings → Read-along first.');
  return url;
}

/**
 * The title/author to search with. For a single-file scope `file` is the playing audio file, so the
 * title comes from its cleaned name (a series torrent's each file is a whole book). Otherwise the
 * stored title wins, falling back to the cleaned torrent name.
 */
export function searchTerms(book: TBTorrent, meta: BookMeta = {}, file?: TBFile): { title: string; author: string } {
  const metaTitle = (meta.title ?? '').trim();
  const metaAuthor = (meta.author ?? '').trim();
  if (file) {
    const fromFile = cleanName(file.name, metaAuthor);
    return {
      title: fromFile.title || metaTitle || cleanName(book.name, metaAuthor).title || prettyName(book.name),
      author: metaAuthor || fromFile.author,
    };
  }
  if (metaTitle) return { title: metaTitle, author: metaAuthor };
  const fromBook = cleanName(book.name, metaAuthor);
  return { title: fromBook.title || prettyName(book.name), author: metaAuthor || fromBook.author };
}

/** Runs the search, keeps the EPUB hits and floats TorBox-cached ones to the top. */
async function candidatesFor(url: string, title: string, author: string, token: string): Promise<EbookCandidate[]> {
  const results: EbookResult[] = await searchEbooks(url, title, author);
  const epubs = results.filter(looksLikeEpub);
  const hashes = [...new Set(epubs.map((r) => r.infoHash).filter((h): h is string => !!h))];
  const [cached, mine] = await Promise.all([
    hashes.length ? checkCached(token, hashes) : Promise.resolve(new Set<string>()),
    listTorrents(token).then((all) => new Set(all.map((t) => t.hash?.toLowerCase()).filter(Boolean))).catch(() => new Set<string>()),
  ]);
  return rankCandidates(epubs, cached).map((c) => ({ ...c, inAccount: !!c.infoHash && mine.has(c.infoHash.toLowerCase()) }));
}

/** EPUB candidates for a book, cached first. Pass `file` when the scope is a single audio file. */
export async function findEpubCandidates(book: TBTorrent, meta: BookMeta = {}, file?: TBFile): Promise<EbookCandidate[]> {
  const [token, url] = await Promise.all([requireKey(), requireSearchUrl()]);
  const { title, author } = searchTerms(book, meta, file);
  return candidatesFor(url, title, author, token);
}

/** Re-runs the EPUB search from the sheet's search box (the author is kept from the book). */
export async function searchEpubCandidates(title: string, author: string): Promise<EbookCandidate[]> {
  const [token, url] = await Promise.all([requireKey(), requireSearchUrl()]);
  return candidatesFor(url, title.trim(), author.trim(), token);
}

function findTorrent(all: TBTorrent[], hash?: string, id?: number): TBTorrent | undefined {
  return all.find((t) =>
    (hash != null && t.hash?.toLowerCase() === hash) || (id != null && t.id === id));
}

/**
 * Makes sure the candidate's torrent is in the user's TorBox and finished, then returns it and its
 * largest `.epub`. Reuses an existing torrent with the same hash rather than adding a second copy;
 * otherwise adds the magnet (only ever after the sheet's confirm). Polls for up to three minutes.
 *
 * Uses the unfiltered `listTorrents` rather than `listBooks`: an EPUB-only torrent does not look
 * like an audiobook, so the library filter would hide it as soon as it finished.
 */
export async function ensureEpubInTorbox(
  candidate: EbookCandidate,
  check: () => void = () => {},
): Promise<{ torrent: TBTorrent; file: TBFile; added: boolean }> {
  const token = await requireKey();
  let hash = candidate.infoHash?.toLowerCase();
  job.preparing('Checking your TorBox…');

  let all = await listTorrents(token);
  check();
  let torrent = findTorrent(all, hash);
  let added = false;
  let addedId: number | undefined;

  if (!torrent) {
    if (!candidate.magnet) throw new Error('That result has no magnet, so it can’t be added to TorBox.');
    job.preparing(`Adding “${candidate.title}” to your TorBox…`);
    const res = await addMagnet(token, candidate.magnet, candidate.title);
    added = true;
    addedId = res?.torrent_id;
    if (res?.hash) hash = res.hash.toLowerCase();
    check();
  } else if (!hash && torrent.hash) {
    hash = torrent.hash.toLowerCase();
  }

  const deadline = Date.now() + EPUB_WAIT_MS;
  for (;;) {
    if (!torrent) {
      all = await listTorrents(token);
      check();
      torrent = findTorrent(all, hash, addedId);
    }
    const file = torrent?.files ? largestEpub(torrent.files) : null;
    if (torrent && isReady(torrent) && file) return { torrent, file, added };
    if (Date.now() >= deadline) break;
    job.preparing(torrent ? 'Waiting for TorBox to finish the EPUB…' : 'Waiting for TorBox to add the EPUB…');
    await sleep(EPUB_POLL_MS);
    check();
    if (torrent) {
      all = await listTorrents(token);
      check();
      torrent = findTorrent(all, hash, addedId) ?? torrent;
    }
  }
  throw new Error('TorBox didn’t finish the EPUB in three minutes. Check torbox.app, then try again.');
}

/**
 * Downloads the EPUB into the desktop app, parses it, runs the Python tool and saves the resulting
 * anchors record. Drives job.ts (via the bridge's events) throughout. Cancelling through
 * `cancelBuild` makes `bridge.run` reject with "cancelled".
 */
export async function buildReadalong(
  book: TBTorrent,
  fileIds: number[],
  epubTorrent: TBTorrent,
  epubFile: TBFile,
): Promise<ReadalongRecord> {
  const bridge = readalongBridge();
  if (!bridge) throw new Error('Read-along is only available in the desktop app.');
  const token = await requireKey();

  job.preparing('Downloading the EPUB…');
  const url = await getStreamUrl(token, epubTorrent.id, epubFile.id);
  const bytes = await bridge.fetchEpub(url, book.hash);

  job.preparing('Reading the EPUB…');
  const { title, paragraphs } = parseEpub(bytes);
  if (paragraphs.length < MIN_PARAGRAPHS) {
    throw new Error(`That EPUB only has ${paragraphs.length} paragraphs — too little text to align. Try another result.`);
  }

  job.preparing('Preparing the audiobook…');
  const off = bridge.onEvent(job.applyJobEvent);
  let anchors: ReadalongAnchorsJson;
  try {
    anchors = await bridge.run({ hash: book.hash, fileIds, title, paragraphs });
  } finally {
    off();
  }

  // The record points at the EPUB torrent (not the audiobook) so the phone can fetch the same file.
  const record = fromAnchorsJson(anchors, { hash: epubTorrent.hash.toLowerCase(), fileId: epubFile.id });
  await saveReadalong(book.hash, record);
  return record;
}

/**
 * The server build, after the user has confirmed a candidate: make sure the EPUB is in TorBox,
 * download it on this device (reusing the phone's EPUB downloader or the desktop bridge), split it
 * into paragraphs, POST the job and remember it. Returns the server job id. Resets the shared job
 * and records any failure there so the sheet can show it.
 */
export async function submitServerBuild(
  book: TBTorrent,
  fileIds: number[],
  candidate: EbookCandidate,
): Promise<string> {
  const run = ++currentRun;
  const check = () => stopIfCancelled(run);
  job.resetJob();
  try {
    const { torrent, file } = await ensureEpubInTorbox(candidate, check);

    job.preparing('Downloading the EPUB…');
    const bytes = await fetchEpubBytes(torrent, file, book.hash, () => { if (run === currentRun) job.preparing('Downloading the EPUB…'); });
    check();

    job.preparing('Reading the EPUB…');
    const { title, paragraphs } = parseEpub(bytes);
    if (paragraphs.length < MIN_PARAGRAPHS) {
      throw new Error(`That EPUB only has ${paragraphs.length} paragraphs — too little text to align. Try another result.`);
    }

    job.preparing('Sending to the read-along server…');
    const summary = await submitJob({
      audioHash: book.hash,
      fileIds,
      epub: { hash: torrent.hash.toLowerCase(), fileId: file.id, title },
      paragraphs,
      paragraphsSha1: paragraphsSha1(paragraphs),
    });

    const pending = addPending(await loadPendingJobs(), book.hash, summary.id);
    await savePendingJobs(pending);
    return summary.id;
  } catch (e) {
    if (run === currentRun && job.getJob().status !== 'cancelled') job.failed(errorMessage(e));
    throw e;
  }
}

/**
 * The whole build after the user has confirmed a candidate: ensure it is in TorBox, then build.
 * Resets the shared job and records any failure there so the sheet can show it.
 */
export async function runReadalong(
  book: TBTorrent,
  fileIds: number[],
  candidate: EbookCandidate,
): Promise<ReadalongRecord> {
  const run = ++currentRun;
  job.resetJob();
  try {
    const { torrent, file } = await ensureEpubInTorbox(candidate, () => stopIfCancelled(run));
    return await buildReadalong(book, fileIds, torrent, file);
  } catch (e) {
    if (run === currentRun && job.getJob().status !== 'cancelled') job.failed(errorMessage(e));
    throw e;
  }
}

/** Cancels the running build, if any. */
export async function cancelBuild(): Promise<void> {
  currentRun++;
  job.cancelled();
  try { await readalongBridge()?.cancel(); } catch { /* the job may already be gone */ }
}
