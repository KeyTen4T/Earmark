// Converts "provider.json" search sources (the format made by source builders such as
// Forge & Fable: schemaVersion + adapters.search.request/response) into Earmark scrapers.
import type { ScraperDef } from './engine';

type Provider = {
  schemaVersion?: string;
  id?: string;
  name?: string;
  version?: string | number;
  description?: string;
  rateLimit?: { requestsPerMinute?: number; retryAfterMs?: number };
  adapters?: Record<string, {
    request?: { method?: string; url?: string; headers?: Record<string, string>; body?: unknown };
    response?: { type?: string; resultsPath?: string; mapping?: Record<string, string> };
  }>;
};

export const isProvider = (raw: unknown): boolean => !!(raw as Provider)?.adapters?.search?.request?.url;

// Placeholders these files use, and what Earmark fills them with ({query} is what the user typed).
const QUERY_SLOTS = /\{(TITLE|QUERY|SEARCH|TERM|KEYWORDS?)\}/g;
const OTHER_SLOTS = /\{[A-Z_]+\}/g;

/** Turns a provider's request template into Earmark's: {TITLE} becomes the query, other slots become empty. */
function template(text: string, encode: 'url' | 'json') {
  const Q = '\u0002';
  const t = text.replace(QUERY_SLOTS, Q).replace(OTHER_SLOTS, '');
  // Literal braces (a JSON body is full of them) must be doubled in Earmark templates.
  return t.replace(/\{/g, '{{').replace(/\}/g, '}}').split(Q).join(encode === 'url' ? '{query|urlencode}' : '{query|json}');
}

export function providerToScraper(raw: unknown): ScraperDef {
  const p = raw as Provider;
  const a = p.adapters!.search ?? p.adapters!.source;
  const req = a.request!;
  const res = a.response ?? {};
  if (res.type && res.type !== 'json') throw new Error(`Unsupported provider response type "${res.type}"`);

  // mapping is { earmarkName: responseKey }; fall back to the same name.
  const m = res.mapping ?? {};
  const k = (name: string) => m[name] ?? name;
  const body = req.body == null ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const version = Number.parseInt(String(p.version ?? ''), 10);

  return {
    id: `provider-${p.id ?? p.name ?? 'source'}`,
    name: p.name ?? 'Imported source',
    version: Number.isFinite(version) ? version : undefined,
    description: p.description,
    icon: '🌐',
    rateLimit: p.rateLimit,
    type: 'json',
    search: {
      url: template(req.url!, 'url'),
      method: (req.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
      headers: req.headers,
      body: body ? template(body, 'json') : undefined,
    },
    results: {
      path: res.resultsPath ?? 'results',
      // This is an audiobook app: skip rows the provider marks as ebooks.
      where: `{${k('mediaType')}|default:audio|regex:^(?!ebook$).+}`,
      fields: {
        title: `{${k('cleanTitle')}|clean||${k('title')}|clean||${k('displayTitle')}|clean}`,
        author: `{${k('author')}|first||${k('authors')}|first}`,
        // A provider may give the narrators as an array; keep every name for the full-cast badge.
        narrator: `{${k('narrator')}|join}`,
        cover: `{${k('artworkUrl')}}`,
        size: `{${k('sizeBytes')}|bytes||${k('sizeLabel')}}`,
        seeders: `{${k('seeders')}}`,
        magnet: `{${k('magnetUrl')}}`,
        infoHash: `{${k('infoHash')}|lower}`,
        // Direct archive.org files can still go through TorBox via the item's own torrent.
        torrentUrl: `{${k('audioUrl')}|iatorrent||${k('url')}|iatorrent}`,
      },
    },
  };
}
