import { render, getPath, formatBytes, decodeEntities } from './template';
import type { Vars } from './template';
import { torrentToMagnet, hashFromMagnet } from './bencode';

export type FieldMap = {
  title: string;
  author?: string;
  narrator?: string;
  cover?: string;
  size?: string;
  seeders?: string;
  duration?: string;
  magnet?: string;
  infoHash?: string;
  torrentUrl?: string;
  detailUrl?: string;
};

export type ScraperDef = {
  id: string;
  name: string;
  version?: number;
  description?: string;
  icon?: string; // emoji or short text shown on result badges
  baseUrl?: string;
  rateLimit?: { requestsPerMinute?: number; retryAfterMs?: number }; // enforced in memory, per source
  type: 'json' | 'html';
  search: {
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  };
  results: {
    path?: string; // json: dot path to the result array ("" = root)
    itemRegex?: string; // html: one match per result; groups become {1},{2}… and named groups
    flags?: string;
    limit?: number;
    where?: string; // template; rows where it renders empty are skipped
    fields: FieldMap;
  };
  detail?: {
    url?: string; // defaults to "{detailUrl}"
    type?: 'json' | 'html';
    headers?: Record<string, string>;
    regex?: string; // html: groups available as {1}… in fields below
    trackerRegex?: string; // html: every match's group 1 is a tracker URL, added to a magnet built from infoHash
    // narrator is rendered from the same vars as the rest (html is available), so it can be captured
    // with its own regex independently of the single `regex` result above.
    fields: { magnet?: string; infoHash?: string; torrentUrl?: string; narrator?: string };
  };
};

export type SearchResult = {
  id: string;
  scraperId: string;
  scraperName: string;
  icon?: string;
  title: string;
  author?: string;
  narrator?: string;
  cover?: string;
  size?: string;
  seeders?: string;
  duration?: string;
  magnet?: string;
  infoHash?: string;
  torrentUrl?: string;
  detailUrl?: string;
  vars: Vars;
};

type Fetcher = typeof fetch;
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36';

export function validateScraper(raw: unknown): ScraperDef {
  const d = raw as ScraperDef;
  const fail = (m: string) => { throw new Error(`Invalid scraper: ${m}`); };
  if (!d || typeof d !== 'object') fail('file is not a JSON object');
  const o = d as unknown as Record<string, unknown>;
  // Common mix-ups: files from an add-on's code project rather than a source definition.
  if (o.lockfileVersion || o.dependencies || o.devDependencies || o.scripts) {
    throw new Error('That is an npm project file (package.json / package-lock.json), not a scraper. It lists code packages, not how to search a site.');
  }
  if (o.resources && o.catalogs) throw new Error('That is a Stremio add-on manifest, which Earmark cannot import. It needs a scraper .json (see Format guide).');
  if (!d.id || typeof d.id !== 'string') fail(`"id" is required (this file has: ${Object.keys(o).slice(0, 6).join(', ') || 'nothing'})`);
  if (!d.name || typeof d.name !== 'string') fail('"name" is required');
  if (d.type !== 'json' && d.type !== 'html') fail('"type" must be "json" or "html"');
  if (!d.search?.url) fail('"search.url" is required');
  if (!(d.search.url + (d.search.body ?? '')).includes('{query')) fail('"search.url" (or body) must contain {query}');
  if (!d.results?.fields?.title) fail('"results.fields.title" is required');
  if (d.type === 'html' && !d.results.itemRegex) fail('html scrapers need "results.itemRegex"');
  const f = d.results.fields;
  if (!f.magnet && !f.infoHash && !f.torrentUrl && !(f.detailUrl && d.detail)) {
    fail('results need one of magnet, infoHash, torrentUrl, or detailUrl + detail');
  }
  if (d.type === 'html') {
    try { new RegExp(d.results.itemRegex!, d.results.flags ?? 'g'); }
    catch (e: any) { fail(`itemRegex does not compile: ${e.message}`); }
  }
  return d;
}

function regexRows(text: string, pattern: string, flags = 'gi'): Vars[] {
  const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
  const rows: Vars[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v: Vars = { item: m[0], ...(m.groups ?? {}) };
    m.forEach((g, i) => { if (i > 0) v[String(i)] = g ?? ''; });
    rows.push(v);
    if (m[0] === '') re.lastIndex++;
  }
  return rows;
}

async function request(fetcher: Fetcher, url: string, method = 'GET', headers?: Record<string, string>, body?: string) {
  const res = await fetcher(url, { method, headers: { 'User-Agent': UA, ...headers }, body: method === 'POST' ? body : undefined });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.replace(/\?.*/, '')}`);
  return res;
}

// Search times per source id within the last minute, for sources that publish a rate limit.
const recentSearches = new Map<string, number[]>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function checkRateLimit(def: ScraperDef, now = Date.now()) {
  const max = def.rateLimit?.requestsPerMinute;
  if (!max || max <= 0) return;
  const recent = (recentSearches.get(def.id) ?? []).filter((t) => now - t < 60000);
  if (recent.length >= max) {
    recentSearches.set(def.id, recent);
    throw new Error(`${def.name} allows ${max} searches a minute. Try again in ${Math.ceil((recent[0] + 60000 - now) / 1000)}s.`);
  }
  recentSearches.set(def.id, [...recent, now]);
}

/**
 * Drops repeats of the same torrent found by more than one source, keeping the first seen. Rows with an
 * info hash match on it; rows without one match on title + author + size, so different editions stay.
 */
export function dedupeResults(list: SearchResult[]): SearchResult[] {
  const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Set<string>();
  return list.filter((r) => {
    const hash = r.infoHash ?? (r.magnet ? hashFromMagnet(r.magnet) : null);
    const key = hash ? `h:${hash.toLowerCase()}` : `t:${norm(r.title)}|${norm(r.author)}|${norm(r.size)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What happened during a search, for the source editor's Test panel. */
export type SearchTrace = { url?: string; ms?: number; rows?: number; afterWhere?: number; addable?: number; sample?: Vars };

export async function runSearch(def: ScraperDef, query: string, fetcher: Fetcher = fetch, page = 1, trace: SearchTrace = {}): Promise<SearchResult[]> {
  const started = Date.now();
  const base = def.baseUrl ?? '';
  const q: Vars = { query, page, page0: page - 1 };
  const url = render(def.search.url, q, base);
  const body = render(def.search.body, q, base);
  trace.url = url;
  checkRateLimit(def);
  const send = () => request(fetcher, url, def.search.method, def.search.headers, body);
  // A source that says how long to back off gets one retry when it answers "too many requests".
  const wait = def.rateLimit?.retryAfterMs;
  const res = await send().catch(async (e) => {
    if (!wait || !/^HTTP 429\b/.test(e?.message ?? '')) throw e;
    await sleep(Math.min(wait, 10000));
    return send();
  });

  let rows: Vars[];
  if (def.type === 'json') {
    const json = await res.json();
    const arr = getPath(json, def.results.path ?? '');
    if (!Array.isArray(arr)) throw new Error(`"results.path" did not point to an array`);
    rows = arr.map((r) => (r && typeof r === 'object' ? (r as Vars) : { value: r }));
  } else {
    rows = regexRows(await res.text(), def.results.itemRegex!, def.results.flags);
  }

  const f = def.results.fields;
  const where = def.results.where;
  trace.rows = rows.length;
  trace.sample = rows[0];
  if (where) rows = rows.filter((v) => render(where, v, base) !== '');
  trace.afterWhere = rows.length;
  const results = rows.map((v, i) => {
    const r = (t?: string) => render(t, v, base) || undefined;
    const magnet = r(f.magnet);
    return {
      id: `${def.id}:${i}:${r(f.infoHash) ?? magnet ?? r(f.torrentUrl) ?? r(f.detailUrl) ?? ''}`,
      scraperId: def.id,
      scraperName: def.name,
      icon: def.icon,
      title: r(f.title) ?? 'Untitled',
      author: r(f.author),
      narrator: r(f.narrator),
      cover: r(f.cover),
      size: r(f.size),
      seeders: r(f.seeders),
      duration: r(f.duration),
      magnet,
      infoHash: r(f.infoHash)?.toLowerCase() ?? (magnet ? hashFromMagnet(magnet) ?? undefined : undefined),
      torrentUrl: r(f.torrentUrl),
      detailUrl: r(f.detailUrl),
      vars: v,
    };
  });
  // A row with no way to reach a torrent can't be added to TorBox, so don't offer it.
  const addable = (x: SearchResult) => !!(x.magnet || x.infoHash || x.torrentUrl || (x.detailUrl && def.detail));
  const usable = results.filter(addable);
  trace.addable = usable.length;
  trace.ms = Date.now() - started;
  return usable.slice(0, def.results.limit ?? 50);
}

/** Detail-page fields for a tapped result: everything a source can render from its detail page. */
export type DetailFields = { narrator?: string; magnet?: string; infoHash?: string; torrentUrl?: string };

/**
 * Fetches a result's detail page once and renders its fields, so a tap can fill in the narrator and the
 * info hash from one request. Shares its parsing with resolveMagnet. Empty when there is no detail page.
 */
export async function fetchDetail(def: ScraperDef | undefined, item: SearchResult, fetcher: Fetcher = fetch): Promise<DetailFields> {
  if (!def?.detail || !item.detailUrl) return {};
  const base = def.baseUrl ?? '';
  const vars: Vars = { ...item.vars, detailUrl: item.detailUrl };
  const url = render(def.detail.url ?? '{detailUrl}', vars, base);
  const res = await request(fetcher, url, 'GET', def.detail.headers);
  let dv: Vars;
  if (def.detail.type === 'json') dv = { ...vars, ...(await res.json()) };
  else {
    const html = await res.text();
    const row = def.detail.regex ? regexRows(html, def.detail.regex, 'i')[0] : undefined;
    dv = { ...vars, html, ...(row ?? {}) };
  }
  const r = (t?: string) => render(t, dv, base) || undefined;
  const infoHash = r(def.detail.fields.infoHash);
  const magnet = r(def.detail.fields.magnet) ?? (infoHash ? detailMagnet(infoHash, item.title, dv, def) : undefined);
  return { narrator: r(def.detail.fields.narrator), magnet, infoHash, torrentUrl: r(def.detail.fields.torrentUrl) };
}

// A bare info hash leaves TorBox to find peers over DHT alone, which often fails; trackers fix that.
function detailMagnet(infoHash: string, title: string, dv: Vars, def: ScraperDef): string {
  const found = def.detail?.trackerRegex && typeof dv.html === 'string'
    ? regexRows(dv.html, def.detail.trackerRegex, 'gi').map((v) => decodeEntities(String(v['1'] ?? v.item)).trim())
    : [];
  const trackers = [...new Set(found.filter((t) => /^(udp|https?|wss?):\/\//i.test(t)))].slice(0, 30);
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}` + trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
}

// Turns any result into a magnet link TorBox can ingest.
export async function resolveMagnet(def: ScraperDef | undefined, item: SearchResult, fetcher: Fetcher = fetch): Promise<string> {
  if (item.magnet) return item.magnet;
  if (item.infoHash) return `magnet:?xt=urn:btih:${item.infoHash}&dn=${encodeURIComponent(item.title)}`;

  let torrentUrl = item.torrentUrl;
  if (!torrentUrl && item.detailUrl && def?.detail) {
    const d = await fetchDetail(def, item, fetcher);
    if (d.magnet) return d.magnet;
    torrentUrl = d.torrentUrl;
  }
  if (!torrentUrl) throw new Error('This result has no magnet or torrent link');

  const res = await request(fetcher, torrentUrl);
  const t = torrentToMagnet(new Uint8Array(await res.arrayBuffer()));
  // e.g. archive.org's LibriVox M4B collections: one item, 1000+ books, 600+ GB.
  if (t.totalSize > MAX_BOOK_BYTES) {
    throw new Error(`That's a ${formatBytes(t.totalSize)} collection, not a single book. Try another result.`);
  }
  return t.magnet;
}

const MAX_BOOK_BYTES = 40 * 1024 ** 3;
