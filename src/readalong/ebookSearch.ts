// EPUB search for the read-along builder. A port of `cmd_ebook_search` from
// tools/readalong/readalong.py: it POSTs a title/author to the EPUB search endpoint the user set in
// Settings and normalises the rows we can actually hand to TorBox (a magnet or an info-hash).
//
// Pure: no react-native, expo or node APIs, so it runs under the Node test runner, Hermes and the
// web. `fetch` is the only side effect and it can be injected for tests.

import { formatBytes } from '../scrapers/template';
import { hashFromMagnet } from '../scrapers/bencode';
import { fetchWithTimeout } from '../fetch-timeout';

/** readalong.py's `--limit` default. */
export const EBOOK_SEARCH_LIMIT = 25;

/** True for a usable http(s) address (the only kind the EPUB search setting accepts). Pure. */
export const isHttpUrl = (raw: string): boolean => /^https?:\/\/\S+$/i.test((raw ?? '').trim());

/** A search hit, flattened to the fields the app uses. `format` is the raw provider label. */
export type EbookResult = {
  title: string;
  format: string;
  sizeBytes: number;
  sizeLabel: string;
  source: string;
  seeders: number | null;
  infoHash?: string;
  magnet?: string;
  url?: string;
};

/**
 * A search hit with the TorBox cache flag the sheet renders as a badge. `inAccount` is set when the
 * torrent is already in the user's TorBox, so confirming adds nothing.
 */
export type EbookCandidate = EbookResult & { cached: boolean; inAccount?: boolean };

function str(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function int(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = str(value);
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalises one raw provider row. Mirrors the fallback chain in `cmd_ebook_search`:
 * title `cleanTitle | originalTitle | title`; format `format | fileFormat | extension | mediaKind`;
 * size `sizeLabel | sizeBytes | size`; source `sourceLabel | source | indexer`; seeders
 * `seeders | seedCount | seeds | seedersDisplay`. Rows with neither a magnet nor an info-hash are
 * dropped (TorBox can only add a torrent).
 */
export function normalizeEbookResult(raw: Record<string, unknown>): EbookResult | null {
  const title = str(raw.cleanTitle) || str(raw.originalTitle) || str(raw.title) || '(untitled)';
  const format = str(raw.format) || str(raw.fileFormat) || str(raw.extension) || str(raw.mediaKind) || '';
  const sizeBytes = int(raw.sizeBytes) ?? int(raw.size) ?? 0;
  const sizeLabel = str(raw.sizeLabel) || (sizeBytes > 0 ? formatBytes(sizeBytes) : '');
  const source = str(raw.sourceLabel) || str(raw.source) || str(raw.indexer) || '';
  const seeders = int(raw.seeders) ?? int(raw.seedCount) ?? int(raw.seeds) ?? int(raw.seedersDisplay);
  const magnet = str(raw.magnetUrl) || undefined;
  const declared = str(raw.infoHash).toLowerCase();
  const infoHash = declared || (magnet ? hashFromMagnet(magnet) ?? undefined : undefined);
  const url = str(raw.url) || undefined;
  if (!magnet && !infoHash) return null;
  return { title, format, sizeBytes, sizeLabel, source, seeders, infoHash, magnet, url };
}

/** Whether a normalised hit is an EPUB (format first, then a `.epub` title or URL). */
export function looksLikeEpub(candidate: EbookResult): boolean {
  if (/epub/i.test(candidate.format)) return true;
  const blob = `${candidate.title} ${candidate.url ?? ''} ${candidate.magnet ?? ''}`;
  return !candidate.format && /\.epub\b/i.test(blob);
}

/** Marks each hit as cached and orders it cached-first, then by seeders, then by size. */
export function rankCandidates(results: EbookResult[], cached: Set<string>): EbookCandidate[] {
  return results
    .map((r) => ({ ...r, cached: !!r.infoHash && cached.has(r.infoHash.toLowerCase()) }))
    .sort((a, b) =>
      Number(b.cached) - Number(a.cached) ||
      (b.seeders ?? -1) - (a.seeders ?? -1) ||
      b.sizeBytes - a.sizeBytes);
}

/**
 * POSTs `{title, author, limit, contentType:"ebook"}` to `url` and returns the normalised,
 * torrentable results. Non-torrentable rows are dropped; a source with no results yields `[]`.
 */
export async function searchEbooks(
  url: string,
  title: string,
  author: string,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<EbookResult[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, author, limit: opts.limit ?? EBOOK_SEARCH_LIMIT, contentType: 'ebook' }),
  }, 20_000, doFetch);
  if (!res.ok) throw new Error(`Ebook search failed (HTTP ${res.status}).`);
  let data: { results?: unknown } | null = null;
  try { data = (await res.json()) as { results?: unknown }; } catch { return []; }
  const rows = Array.isArray(data?.results) ? data!.results : [];
  const out: EbookResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const norm = normalizeEbookResult(row as Record<string, unknown>);
    if (norm) out.push(norm);
  }
  return out;
}
